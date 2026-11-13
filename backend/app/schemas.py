from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class MapCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=4000)


class MapPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=4000)
    visibility: Optional[Literal["private", "public"]] = None


class MapOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: Optional[str]
    visibility: str
    created_by: str
    created_at: datetime
    updated_at: datetime


class LayerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=4000)
    color: str = Field(default="#318b69", pattern=r"^#[0-9A-Fa-f]{6}$")
    icon: Optional[str] = Field(default=None, max_length=64)
    sort_order: int = 0
    is_visible_by_default: bool = True


class LayerPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=4000)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    icon: Optional[str] = Field(default=None, max_length=64)
    sort_order: Optional[int] = None
    is_visible_by_default: Optional[bool] = None


class LayerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    map_id: UUID
    name: str
    description: Optional[str]
    color: str
    icon: Optional[str]
    sort_order: int
    is_visible_by_default: bool
    created_at: datetime
    updated_at: datetime


class MemberCreate(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    role: Literal["editor", "viewer"]


class MemberOut(BaseModel):
    map_id: UUID
    user_id: str
    role: str
    created_at: datetime


class PointCreate(BaseModel):
    id: UUID
    layer_id: UUID
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    title: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=10000)
    captured_at: datetime = Field(default_factory=utcnow)
    client_created_at: Optional[datetime] = None
    location_accuracy_m: Optional[float] = Field(default=None, ge=0)


class PointPatch(BaseModel):
    expected_version: int = Field(ge=1)
    layer_id: Optional[UUID] = None
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    title: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=10000)
    captured_at: Optional[datetime] = None
    location_accuracy_m: Optional[float] = Field(default=None, ge=0)


class PhotoOut(BaseModel):
    id: UUID
    original_filename: str
    mime_type: str
    size_bytes: int
    width: int
    height: int
    captured_at: Optional[datetime]
    uploaded_at: datetime
    url: str
    thumbnail_url: str


class PointOut(BaseModel):
    id: UUID
    map_id: UUID
    layer_id: UUID
    lat: float
    lng: float
    title: Optional[str]
    description: Optional[str]
    created_by: str
    captured_at: datetime
    created_at: datetime
    updated_at: datetime
    client_created_at: Optional[datetime]
    location_accuracy_m: Optional[float]
    version: int
    photos: list[PhotoOut]


class SyncEventOut(BaseModel):
    id: int
    entity_type: str
    entity_id: UUID
    action: str
    version: int
    actor_id: str
    created_at: datetime
