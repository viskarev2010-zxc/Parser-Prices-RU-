import asyncio
import csv
import io
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..excel_service import build_workbook
from ..models import PriceHistory, Product
from ..parser_service import fetch_price
from ..schemas import (
    AdminLogin,
    CheckAllOut,
    PriceHistoryOut,
    ProductCreate,
    ProductOut,
    ProductUpdate,
    StatsOut,
    TokenOut,
)
from ..security import (
    create_access_token,
    get_current_admin,
    rate_limit,
    verify_admin_password,
)

router = APIRouter(prefix="/api/products", tags=["products"])
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])
export_router = APIRouter(prefix="/api/export", tags=["export"])
stats_router = APIRouter(prefix="/api", tags=["stats"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CSV_MEDIA_TYPE = "text/csv; charset=utf-8"

DEMO_PRODUCTS = (
    ("Ноутбук DemoBook 15", "demo-store/laptop", ".product-price", 90000.0),
    ("Смартфон DemoPhone X", "demo-store/phone", None, 50000.0),
)

SortKey = Literal["newest", "title", "price_asc", "price_desc"]


def _current_price(product: Product) -> float | None:
    if not product.prices:
        return None
    return max(product.prices, key=lambda item: item.recorded_at).price


def _to_out(product: Product) -> ProductOut:
    prices = sorted(product.prices, key=lambda item: item.recorded_at)
    current = prices[-1].price if prices else None
    change = None
    if len(prices) >= 2 and prices[-2].price:
        change = round((prices[-1].price - prices[-2].price) / prices[-2].price * 100, 2)

    return ProductOut(
        id=product.id,
        title=product.title,
        url=product.url,
        css_selector=product.css_selector,
        target_price=product.target_price,
        notes=product.notes,
        created_at=product.created_at,
        current_price=current,
        min_price=min((item.price for item in prices), default=None),
        max_price=max((item.price for item in prices), default=None),
        change_percent=change,
        checks_count=len(prices),
    )


def _get_product(product_id: int, db: Session) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Товар не найден")
    return product


def _is_deal(product: Product) -> bool:
    current = _current_price(product)
    return (
        current is not None
        and product.target_price is not None
        and current <= product.target_price
    )


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
        notes=payload.notes,
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


@router.post("/check-all", response_model=CheckAllOut, dependencies=[Depends(rate_limit(5))])
async def check_all_prices(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    products = db.scalars(select(Product)).all()
    if not products:
        return CheckAllOut(checked=0, updated=0, failed=0)

    semaphore = asyncio.Semaphore(5)

    async def worker(product: Product):
        async with semaphore:
            try:
                return product.id, await fetch_price(product.url, product.css_selector)
            except Exception:
                return product.id, None

    results = await asyncio.gather(*(worker(product) for product in products))

    updated = 0
    for product_id, price in results:
        if price is not None:
            db.add(PriceHistory(product_id=product_id, price=price))
            updated += 1
    db.commit()

    return CheckAllOut(checked=len(products), updated=updated, failed=len(products) - updated)


@router.post("/seed-demo", response_model=list[ProductOut])
async def seed_demo_products(
    request: Request,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    base_url = str(request.base_url).rstrip("/")
    created: list[ProductOut] = []

    for title, path, selector, target in DEMO_PRODUCTS:
        url = f"{base_url}/{path}"
        if db.scalar(select(Product).where(Product.url == url)):
            continue

        product = Product(
            title=title,
            url=url,
            css_selector=selector,
            target_price=target,
            notes="Демонстрационный товар со случайной ценой на каждом запросе.",
        )
        db.add(product)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue

        try:
            await _measure(product, db)
        except HTTPException:
            db.delete(product)
            db.commit()
            continue

        created.append(_to_out(product))

    return created


@router.get("", response_model=list[ProductOut])
def list_products(
    search: str | None = Query(default=None, max_length=100),
    sort: SortKey = "newest",
    only_deals: bool = False,
    db: Session = Depends(get_db),
):
    products = db.scalars(
        select(Product)
        .options(selectinload(Product.prices))
        .order_by(Product.created_at.desc(), Product.id.desc())
    ).all()

    if search:
        needle = search.casefold()
        products = [
            product
            for product in products
            if needle in product.title.casefold()
            or needle in product.url.casefold()
            or needle in (product.notes or "").casefold()
        ]

    if only_deals:
        products = [product for product in products if _is_deal(product)]

    if sort == "title":
        products.sort(key=lambda item: item.title.casefold())
    elif sort in {"price_asc", "price_desc"}:
        priced = [item for item in products if _current_price(item) is not None]
        unpriced = [item for item in products if _current_price(item) is None]
        priced.sort(key=_current_price, reverse=sort == "price_desc")
        products = priced + unpriced

    return [_to_out(product) for product in products]


@router.patch("/{product_id}", response_model=ProductOut)
def update_product(
    product_id: int,
    payload: ProductUpdate,
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    product = _get_product(product_id, db)
    changes = payload.model_dump(exclude_unset=True)

    for field, value in changes.items():
        setattr(product, field, value)

    db.commit()
    db.refresh(product)
    return _to_out(product)


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


@stats_router.get("/stats", response_model=StatsOut)
def get_stats(db: Session = Depends(get_db)):
    products = db.scalars(select(Product).options(selectinload(Product.prices))).all()
    last_check_at = db.scalar(select(func.max(PriceHistory.recorded_at)))
    history_entries = db.scalar(select(func.count(PriceHistory.id))) or 0

    return StatsOut(
        total_products=len(products),
        deals_count=sum(1 for product in products if _is_deal(product)),
        history_entries=history_entries,
        last_check_at=last_check_at,
    )


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


@export_router.get("/csv")
def export_csv(
    db: Session = Depends(get_db),
    _: str = Depends(get_current_admin),
):
    products = db.scalars(
        select(Product).options(selectinload(Product.prices)).order_by(Product.id)
    ).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";")
    writer.writerow(
        [
            "ID",
            "Название",
            "Ссылка",
            "Целевая цена",
            "Актуальная цена",
            "Отклонение от цели",
            "Замеров",
            "Последний замер",
        ]
    )

    for product in products:
        prices = sorted(product.prices, key=lambda item: item.recorded_at)
        current = prices[-1].price if prices else None
        deviation = (
            round(current - product.target_price, 2)
            if current is not None and product.target_price is not None
            else None
        )
        writer.writerow(
            [
                product.id,
                product.title,
                product.url,
                product.target_price,
                current,
                deviation,
                len(prices),
                prices[-1].recorded_at.strftime("%d.%m.%Y %H:%M") if prices else "",
            ]
        )

    data = io.BytesIO(("\ufeff" + buffer.getvalue()).encode("utf-8"))
    filename = f"price_report_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return StreamingResponse(
        data,
        media_type=CSV_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
