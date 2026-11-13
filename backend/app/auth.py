import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import MapRecord


@dataclass(frozen=True)
class Principal:
    user_id: str
    map_id: UUID | None = None
    map_role: str | None = None
    is_anonymous: bool = False


class IdentityAdapter(Protocol):
    def authenticate(self, request: Request) -> Principal:
        ...


class DevelopmentIdentityAdapter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def authenticate(self, request: Request) -> Principal:
        user_id = request.headers.get("X-Dev-User", self.settings.development_user_id)
        if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", user_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid development user identifier",
            )
        return Principal(user_id=user_id)


def generate_share_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return token, token_hash


class TrustedProxyIdentityAdapter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def authenticate(self, request: Request) -> Principal:
        proxy_secret = self.settings.trusted_proxy_secret
        if not proxy_secret:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Trusted proxy authentication is not configured",
            )

        supplied_secret = request.headers.get("X-Field-Map-Proxy-Secret", "")
        user_id = request.headers.get("X-Field-Map-User", "")
        if not hmac.compare_digest(supplied_secret, proxy_secret) or not re.fullmatch(
            r"[A-Za-z0-9._@:-]{1,128}", user_id
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required",
                headers={"WWW-Authenticate": "Basic"},
            )
        return Principal(user_id=user_id)


def get_current_user(
    request: Request,
    session: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Principal:
    share_token = request.headers.get("X-Map-Share-Token")
    if share_token is not None:
        if not share_token or len(share_token) > 256:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid private map link",
            )
        token_hash = hashlib.sha256(share_token.encode("utf-8")).hexdigest()
        map_record = session.scalar(
            select(MapRecord).where(
                or_(
                    MapRecord.owner_share_hash == token_hash,
                    MapRecord.editor_share_hash == token_hash,
                    MapRecord.viewer_share_hash == token_hash,
                )
            )
        )
        if map_record is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid private map link",
            )
        if map_record.owner_share_hash == token_hash:
            role = "owner"
        elif map_record.editor_share_hash == token_hash:
            role = "editor"
        else:
            role = "viewer"
        return Principal(
            user_id="anonymous",
            map_id=map_record.id,
            map_role=role,
            is_anonymous=True,
        )

    if settings.app_environment == "development":
        return DevelopmentIdentityAdapter(settings).authenticate(request)

    if (
        request.headers.get("X-Field-Map-User") is not None
        or request.headers.get("X-Field-Map-Proxy-Secret") is not None
    ):
        return TrustedProxyIdentityAdapter(settings).authenticate(request)

    if settings.anonymous_links_enabled:
        return Principal(user_id="anonymous", is_anonymous=True)

    return TrustedProxyIdentityAdapter(settings).authenticate(request)
