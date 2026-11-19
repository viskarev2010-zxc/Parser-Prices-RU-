import ipaddress
import re
import socket
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

CURRENCY_RE = r"(?:₽|руб\.?|р\.|RUB|\$|€|EUR)"
PRICE_AFTER_RE = re.compile(
    rf"\d[\d\s\u00a0\u202f]*(?:[.,]\d{{1,2}})?\s*{CURRENCY_RE}", re.IGNORECASE
)
PRICE_BEFORE_RE = re.compile(
    rf"{CURRENCY_RE}\s*\d[\d\s\u00a0\u202f]*(?:[.,]\d{{1,2}})?", re.IGNORECASE
)
META_KEYS = {
    "product:price:amount",
    "og:price:amount",
    "price",
    "twitter:data1",
    "product:sale_price:amount",
}


def parse_price(raw: str | None) -> float | None:
    if not raw:
        return None

    text = re.sub(r"[^\d.,]", "", raw)
    if not text:
        return None

    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        head, _, tail = text.rpartition(",")
        text = f"{head.replace(',', '')}.{tail}" if len(tail) <= 2 else text.replace(",", "")

    parts = text.split(".")
    if len(parts) > 2:
        text = "".join(parts[:-1]) + "." + parts[-1]

    try:
        return float(text)
    except ValueError:
        return None


def extract_price(html: str, css_selector: str | None = None) -> float | None:
    soup = BeautifulSoup(html, "html.parser")

    if css_selector:
        node = soup.select_one(css_selector)
        if node:
            price = parse_price(node.get_text(" ", strip=True))
            if price is not None:
                return price

    for meta in soup.find_all("meta"):
        key = (meta.get("property") or meta.get("name") or "").lower()
        if key in META_KEYS:
            price = parse_price(meta.get("content"))
            if price is not None:
                return price

    for node in soup.select("[itemprop=price]"):
        price = parse_price(node.get("content") or node.get_text(" ", strip=True))
        if price is not None:
            return price

    text = soup.get_text(" ", strip=True)
    for pattern in (PRICE_AFTER_RE, PRICE_BEFORE_RE):
        match = pattern.search(text)
        if match:
            price = parse_price(match.group(0))
            if price is not None:
                return price

    return None


ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
ALLOWED_SCHEMES = {"http", "https"}


def validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise ValueError("Разрешены только схемы http и https")

    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Некорректный URL")
    if host in ALLOWED_HOSTS:
        return url

    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except socket.gaierror as exc:
        raise ValueError(f"Не удалось разрешить хост: {host}") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError(f"Запрещён внутренний адрес: {host}")

    return url


async def fetch_price(url: str, css_selector: str | None = None) -> float | None:
    validate_url(url)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PriceTracker/1.0"}
    async with httpx.AsyncClient(
        follow_redirects=True, timeout=20.0, headers=headers
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        validate_url(str(response.url))
        return extract_price(response.text, css_selector)
