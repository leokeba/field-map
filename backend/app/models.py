from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class MapRecord(Base):
    __tablename__ = "maps"
    __table_args__ = (
        CheckConstraint("visibility IN ('private', 'public')", name="ck_maps_visibility"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="private")
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    owner_share_hash: Mapped[Optional[str]] = mapped_column(String(64), unique=True, index=True)
    editor_share_hash: Mapped[Optional[str]] = mapped_column(String(64), unique=True, index=True)
    viewer_share_hash: Mapped[Optional[str]] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=utcnow
    )

    memberships: Mapped[list["MapMembership"]] = relationship(
        back_populates="map", cascade="all, delete-orphan"
    )
    layers: Mapped[list["LayerRecord"]] = relationship(
        back_populates="map", cascade="all, delete-orphan"
    )
    points: Mapped[list["PointRecord"]] = relationship(
        back_populates="map", cascade="all, delete-orphan"
    )


class MapMembership(Base):
    __tablename__ = "map_memberships"
    __table_args__ = (
        CheckConstraint("role IN ('owner', 'editor', 'viewer')", name="ck_membership_role"),
    )

    map_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("maps.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    map: Mapped[MapRecord] = relationship(back_populates="memberships")


class LayerRecord(Base):
    __tablename__ = "layers"
    __table_args__ = (
        UniqueConstraint("id", "map_id", name="uq_layers_id_map"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    map_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("maps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    color: Mapped[str] = mapped_column(String(7), nullable=False, default="#318b69")
    icon: Mapped[Optional[str]] = mapped_column(String(64))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_visible_by_default: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=utcnow
    )

    map: Mapped[MapRecord] = relationship(back_populates="layers")
    points: Mapped[list["PointRecord"]] = relationship(
        back_populates="layer", foreign_keys="PointRecord.layer_id"
    )


class PointRecord(Base):
    __tablename__ = "points"
    __table_args__ = (
        ForeignKeyConstraint(
            ["layer_id", "map_id"],
            ["layers.id", "layers.map_id"],
            ondelete="RESTRICT",
            name="fk_points_layer_map",
        ),
        CheckConstraint("location_accuracy_m IS NULL OR location_accuracy_m >= 0"),
        CheckConstraint(
            "record_type IN ('poster', 'observation')",
            name="ck_points_record_type",
        ),
        CheckConstraint("quantity >= 1", name="ck_points_quantity"),
        CheckConstraint(
            "status IS NULL OR status IN ('active', 'removed')",
            name="ck_points_status",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    map_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("maps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    layer_id: Mapped[UUID] = mapped_column(Uuid, nullable=False, index=True)
    geom: Mapped[object] = mapped_column(
        Geometry(geometry_type="POINT", srid=4326, spatial_index=True), nullable=False
    )
    title: Mapped[Optional[str]] = mapped_column(String(120))
    description: Mapped[Optional[str]] = mapped_column(Text)
    record_type: Mapped[str] = mapped_column(String(16), nullable=False, default="poster")
    campaign: Mapped[Optional[str]] = mapped_column(String(160))
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[Optional[str]] = mapped_column(String(16))
    last_observed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    removed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    removal_reason: Mapped[Optional[str]] = mapped_column(String(32))
    removal_confidence: Mapped[Optional[str]] = mapped_column(String(16))
    removal_note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    client_created_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    location_accuracy_m: Mapped[Optional[float]]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=utcnow
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    map: Mapped[MapRecord] = relationship(
        back_populates="points", foreign_keys=[map_id]
    )
    layer: Mapped[LayerRecord] = relationship(
        back_populates="points", foreign_keys=[layer_id]
    )
    photos: Mapped[list["PhotoRecord"]] = relationship(
        back_populates="point", cascade="all, delete-orphan", order_by="PhotoRecord.uploaded_at"
    )
    events: Mapped[list["PointEvent"]] = relationship(
        back_populates="point",
        cascade="all, delete-orphan",
        order_by="PointEvent.recorded_at",
    )


class PointEvent(Base):
    __tablename__ = "point_events"
    __table_args__ = (
        CheckConstraint(
            "event_type IN ('placed', 'observed', 'removed')",
            name="ck_point_events_type",
        ),
        CheckConstraint(
            "removal_reason IS NULL OR removal_reason IN "
            "('suspected_opposition', 'weather', 'property_owner', 'other', 'unknown')",
            name="ck_point_events_removal_reason",
        ),
        CheckConstraint(
            "removal_confidence IS NULL OR removal_confidence IN "
            "('suspected', 'confirmed', 'unknown')",
            name="ck_point_events_removal_confidence",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    map_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("maps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    point_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("points.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(16), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    removal_reason: Mapped[Optional[str]] = mapped_column(String(32))
    removal_confidence: Mapped[Optional[str]] = mapped_column(String(16))
    note: Mapped[Optional[str]] = mapped_column(Text)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    point: Mapped[PointRecord] = relationship(back_populates="events")


class PhotoRecord(Base):
    __tablename__ = "photos"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    point_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("points.id", ondelete="CASCADE"), nullable=False, index=True
    )
    storage_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    thumbnail_storage_key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    point: Mapped[PointRecord] = relationship(back_populates="photos")


class SyncEvent(Base):
    __tablename__ = "sync_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    map_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("maps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[UUID] = mapped_column(Uuid, nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_id: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
