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
    current_role: Optional[Literal["owner", "editor", "viewer"]] = None
    created_at: datetime
    updated_at: datetime


class MapCreateOut(BaseModel):
    map: MapOut
    owner_share_token: str


class ShareLinkOut(BaseModel):
    role: Literal["owner", "editor", "viewer"]
    token: str


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


class PointEventCreate(BaseModel):
    event_type: Literal["observed", "removed"]
    occurred_at: datetime
    removal_reason: Optional[
        Literal["suspected_opposition", "weather", "property_owner", "other", "unknown"]
    ] = None
    removal_confidence: Optional[Literal["suspected", "confirmed", "unknown"]] = None
    note: Optional[str] = Field(default=None, max_length=2000)


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
    record_type: Literal["poster", "observation"] = "poster"
    campaign: Optional[str] = Field(default=None, max_length=160)
    quantity: int = Field(default=1, ge=1, le=10000)
    status: Optional[Literal["active", "removed"]] = None
    removed_at: Optional[datetime] = None
    removal_reason: Optional[
        Literal["suspected_opposition", "weather", "property_owner", "other", "unknown"]
    ] = None
    removal_confidence: Optional[Literal["suspected", "confirmed", "unknown"]] = None
    removal_note: Optional[str] = Field(default=None, max_length=2000)
    poster_events: list[PointEventCreate] = Field(default_factory=list)


class PointPatch(BaseModel):
    expected_version: int = Field(ge=1)
    layer_id: Optional[UUID] = None
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    title: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=10000)
    captured_at: Optional[datetime] = None
    location_accuracy_m: Optional[float] = Field(default=None, ge=0)
    campaign: Optional[str] = Field(default=None, max_length=160)
    quantity: Optional[int] = Field(default=None, ge=1, le=10000)
    poster_events: list[PointEventCreate] = Field(default_factory=list)


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
    record_type: Literal["poster", "observation"]
    campaign: Optional[str]
    quantity: int
    status: Optional[Literal["active", "removed"]]
    last_observed_at: Optional[datetime]
    removed_at: Optional[datetime]
    removal_reason: Optional[str]
    removal_confidence: Optional[str]
    removal_note: Optional[str]
    created_by: str
    captured_at: datetime
    created_at: datetime
    updated_at: datetime
    client_created_at: Optional[datetime]
    location_accuracy_m: Optional[float]
    version: int
    photos: list[PhotoOut]


class PointEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    point_id: UUID
    event_type: Literal["placed", "observed", "removed"]
    occurred_at: datetime
    actor_id: str
    removal_reason: Optional[str]
    removal_confidence: Optional[str]
    note: Optional[str]
    recorded_at: datetime


class SyncEventOut(BaseModel):
    id: int
    entity_type: str
    entity_id: UUID
    action: str
    version: int
    actor_id: str
    created_at: datetime
