import random

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/demo-store", tags=["demo-store"])

PAGE = """<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
</head>
<body>
  <h1>{title}</h1>
  <p>Артикул: {sku}</p>
  <p>Цена: <span class="product-price">{price} ₽</span></p>
  <p>Наличие: {stock}</p>
</body>
</html>"""


def _price(low: int, high: int) -> str:
    return f"{random.randint(low, high):,}".replace(",", " ")


def _render(title: str, low: int, high: int) -> HTMLResponse:
    html = PAGE.format(
        title=title,
        sku=f"SKU-{random.randint(10000, 99999)}",
        price=_price(low, high),
        stock=random.choice(["в наличии", "мало", "под заказ"]),
    )
    return HTMLResponse(html)


@router.get("/laptop", response_class=HTMLResponse)
def laptop():
    return _render("Ноутбук DemoBook 15", 45_000, 140_000)


@router.get("/phone", response_class=HTMLResponse)
def phone():
    return _render("Смартфон DemoPhone X", 12_000, 95_000)
