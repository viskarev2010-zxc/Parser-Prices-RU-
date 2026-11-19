import os
from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .database import Base, engine
from .routers import api, demo_store
from .scheduler import run_price_check

CHECK_INTERVAL_MINUTES = int(os.getenv("CHECK_INTERVAL_MINUTES", "30"))
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
scheduler = AsyncIOScheduler(timezone="UTC")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    scheduler.add_job(
        run_price_check,
        "interval",
        minutes=CHECK_INTERVAL_MINUTES,
        id="price_check",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Price Parser API", version="2.0.0", lifespan=lifespan)

app.include_router(api.router)
app.include_router(api.admin_router)
app.include_router(api.export_router)
app.include_router(demo_store.router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok", "check_interval_minutes": CHECK_INTERVAL_MINUTES}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
