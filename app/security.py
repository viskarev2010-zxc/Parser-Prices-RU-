import os
import secrets
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY") or secrets.token_urlsafe(48)
ALGORITHM = "HS256"
TOKEN_TTL = timedelta(hours=8)
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

_ADMIN_HASH = bcrypt.hashpw(ADMIN_PASSWORD.encode()[:72], bcrypt.gensalt())
_bearer = HTTPBearer(auto_error=False)
_attempts: dict[tuple[str, int], deque[float]] = {}


def verify_admin_password(password: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode()[:72], _ADMIN_HASH)
    except ValueError:
        return False


def create_access_token(subject: str = "admin") -> str:
    payload = {
        "sub": subject,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + TOKEN_TTL,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Недействительный токен",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def get_current_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(credentials.credentials)
    subject = payload.get("sub")
    if subject != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Нет доступа")
    return subject


def rate_limit(limit: int, window: int = 60):
    def dependency(request: Request) -> None:
        ip = request.client.host if request.client else "unknown"
        key = (ip, limit, window)
        now = time.monotonic()
        bucket = _attempts.setdefault(key, deque())
        while bucket and now - bucket[0] > window:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Слишком много запросов, попробуйте позже",
            )
        bucket.append(now)

    return dependency
