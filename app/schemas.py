from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class ProductCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    url: HttpUrl
    css_selector: str | None = Field(default=None, max_length=255)
    target_price: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=1000)


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    url: str
    css_selector: str | None
    target_price: float | None
    notes: str | None = None
    created_at: datetime
    current_price: float | None = None
    min_price: float | None = None
    max_price: float | None = None
    change_percent: float | None = None
    checks_count: int = 0


class ProductUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    css_selector: str | None = Field(default=None, max_length=255)
    target_price: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=1000)


class PriceHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: int
    price: float
    recorded_at: datetime


class StatsOut(BaseModel):
    total_products: int
    deals_count: int
    history_entries: int
    last_check_at: datetime | None


class CheckAllOut(BaseModel):
    checked: int
    updated: int
    failed: int


class AdminLogin(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
