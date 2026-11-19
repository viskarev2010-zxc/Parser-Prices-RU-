from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..excel_service import build_workbook
from ..models import PriceHistory, Product
from ..parser_service import fetch_price
from ..schemas import AdminLogin, PriceHistoryOut, ProductCreate, ProductOut, TokenOut
from ..security import (
    create_access_token,
    get_current_admin,
    rate_limit,
    verify_admin_password,
)

router = APIRouter(prefix="/api/products", tags=["products"])
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])
export_router = APIRouter(prefix="/api/export", tags=["export"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _current_price(product: Product) -> float | None:
    if not product.prices:
        return None
    return max(product.prices, key=lambda item: item.recorded_at).price


def _to_out(product: Product) -> ProductOut:
    return ProductOut.model_validate(product).model_copy(
        update={"current_price": _current_price(product)}
    )


def _get_product(product_id: int, db: Session) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Товар не найден")
    return product


async def _measure(product: Product, db: Session) -> float:
    try:
        price = await fetch_price(product.url, product.css_selector)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Ошибка загрузки страницы: {exc}"
        ) from exc

    if price is None:
        raise HTTPException(status_code=422, detail="Цена на странице не найдена")

    db.add(PriceHistory(product_id=product.id, price=price))
    db.commit()
    return price


@router.post("", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
async def create_product(
    payload: ProductCreate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    product = Product(
        title=payload.title,
        url=str(payload.url),
        css_selector=payload.css_selector,
        target_price=payload.target_price,
    )
    db.add(product)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Товар с таким URL уже существует")

    try:
        await _measure(product, db)
    except HTTPException:
        db.delete(product)
        db.commit()
        raise

    return _to_out(product)


@router.get("", response_model=list[ProductOut])
def list_products(db: Session = Depends(get_db)):
    products = db.scalars(
        select(Product)
        .options(selectinload(Product.prices))
        .order_by(Product.created_at.desc(), Product.id.desc())
    ).all()
    return [_to_out(product) for product in products]


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    product = _get_product(product_id, db)
    db.delete(product)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{product_id}/check",
    response_model=ProductOut,
    dependencies=[Depends(rate_limit(10))],
)
async def check_product(
    product_id: int,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    product = _get_product(product_id, db)
    await _measure(product, db)
    db.refresh(product)
    return _to_out(product)


@router.get("/{product_id}/history", response_model=list[PriceHistoryOut])
def product_history(product_id: int, db: Session = Depends(get_db)):
    _get_product(product_id, db)
    return db.scalars(
        select(PriceHistory)
        .where(PriceHistory.product_id == product_id)
        .order_by(PriceHistory.recorded_at.desc(), PriceHistory.id.desc())
    ).all()


@admin_router.post("/login", response_model=TokenOut, dependencies=[Depends(rate_limit(5))])
def admin_login(payload: AdminLogin, request: Request):
    if not verify_admin_password(payload.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный пароль",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return TokenOut(access_token=create_access_token())


@export_router.get("/excel")
def export_excel(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    products = db.scalars(
        select(Product).options(selectinload(Product.prices)).order_by(Product.id)
    ).all()
    stream = build_workbook(list(products))
    filename = f"price_report_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    return StreamingResponse(
        stream,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
