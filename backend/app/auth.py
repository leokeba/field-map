import re
from dataclasses import dataclass
from typing import Protocol

from fastapi import Depends, HTTPException, Request, status

from app.config import Settings, get_settings


@dataclass(frozen=True)
class Principal:
    user_id: str


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


def get_current_user(
    request: Request, settings: Settings = Depends(get_settings)
) -> Principal:
    if settings.app_environment != "development":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No production identity adapter is configured",
        )
    return DevelopmentIdentityAdapter(settings).authenticate(request)
