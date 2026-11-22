import asyncio
import logging

from sqlalchemy import select

from .database import SessionLocal
from .models import PriceHistory, Product
from .parser_service import fetch_price

logger = logging.getLogger(__name__)


async def _fetch(product: Product, semaphore: asyncio.Semaphore):
    async with semaphore:
        try:
            return product, await fetch_price(product.url, product.css_selector)
        except Exception as exc:
            logger.warning("Товар %s (%s): %s", product.id, product.url, exc)
            return product, None


async def run_price_check() -> int:
    with SessionLocal() as db:
        products = db.scalars(select(Product)).all()
        if not products:
            return 0

        semaphore = asyncio.Semaphore(5)
        results = await asyncio.gather(*(_fetch(product, semaphore) for product in products))

        saved = 0
        for product, price in results:
            if price is not None:
                db.add(PriceHistory(product_id=product.id, price=price))
                saved += 1
        db.commit()

        logger.info("Проверка цен: обновлено %d из %d", saved, len(products))
        return saved
