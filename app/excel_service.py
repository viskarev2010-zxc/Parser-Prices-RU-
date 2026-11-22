from datetime import datetime
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .models import Product

HEADER_FONT = Font(bold=True, color="FFFFFF")
HEADER_FILL = PatternFill("solid", fgColor="2F5597")
PRICE_FORMAT = "#,##0.00 ₽"
DATE_FORMAT = "dd.mm.yyyy hh:mm"


def _write_header(ws, headers: list[str]) -> None:
    ws.append(headers)
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center")
    ws.freeze_panes = "A2"


def _autofit(ws) -> None:
    widths: dict[str, int] = {}
    for row in ws.iter_rows():
        for cell in row:
            text = "" if cell.value is None else str(cell.value)
            widths[cell.column_letter] = max(widths.get(cell.column_letter, 0), len(text))
    for letter, width in widths.items():
        ws.column_dimensions[letter].width = min(width + 2, 60)


def _latest_price(product: Product):
    if not product.prices:
        return None
    return max(product.prices, key=lambda item: item.recorded_at)


def build_workbook(products: list[Product]) -> BytesIO:
    wb = Workbook()

    current = wb.active
    current.title = "Текущие цены"
    _write_header(
        current,
        [
            "ID",
            "Название",
            "Ссылка",
            "Целевая цена",
            "Актуальная цена",
            "Отклонение от цели (руб.)",
            "Дата последнего замера",
            "Заметка",
        ],
    )

    for product in products:
        last = _latest_price(product)
        current_price = last.price if last else None
        deviation = (
            round(current_price - product.target_price, 2)
            if current_price is not None and product.target_price is not None
            else None
        )
        current.append(
            [
                product.id,
                product.title,
                product.url,
                product.target_price,
                current_price,
                deviation,
                last.recorded_at if last else None,
                product.notes or "",
            ]
        )
        row = current.max_row
        for col in (4, 5, 6):
            current.cell(row=row, column=col).number_format = PRICE_FORMAT
        current.cell(row=row, column=7).number_format = DATE_FORMAT

    history = wb.create_sheet("История цен")
    _write_header(history, ["Название товара", "Цена", "Дата и время фиксации"])
    for product in products:
        for entry in sorted(product.prices, key=lambda item: item.recorded_at):
            history.append([product.title, entry.price, entry.recorded_at])
            row = history.max_row
            history.cell(row=row, column=2).number_format = PRICE_FORMAT
            history.cell(row=row, column=3).number_format = DATE_FORMAT

    for ws in (current, history):
        _autofit(ws)

    stream = BytesIO()
    wb.save(stream)
    stream.seek(0)
    return stream
