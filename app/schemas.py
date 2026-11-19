from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class ProductCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    url: HttpUrl
    css_selector: str | None = Field(default=None, max_length=255)
    target_price: float | None = Field(default=None, ge=0)


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    url: str
    css_selector: str | None
    target_price: float | None
    created_at: datetime
    current_price: float | None = None


class PriceHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: int
    price: float
    recorded_at: datetime


class AdminLogin(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
