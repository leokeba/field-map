from pathlib import Path
from typing import Optional
from uuid import UUID

from geoalchemy2.functions import ST_X, ST_Y
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PhotoRecord, PointEvent, PointRecord, SyncEvent
from app.schemas import PhotoOut, PointEventCreate, PointOut


def photo_to_out(photo: PhotoRecord) -> PhotoOut:
    return PhotoOut(
        id=photo.id,
        original_filename=photo.original_filename,
        mime_type=photo.mime_type,
        size_bytes=photo.size_bytes,
        width=photo.width,
        height=photo.height,
        captured_at=photo.captured_at,
        uploaded_at=photo.uploaded_at,
        url="/api/photos/{0}".format(photo.id),
        thumbnail_url="/api/photos/{0}?thumbnail=true".format(photo.id),
    )


def point_to_out(session: Session, point: PointRecord) -> PointOut:
    lng, lat = session.execute(
        select(ST_X(PointRecord.geom), ST_Y(PointRecord.geom)).where(
            PointRecord.id == point.id
        )
    ).one()
    return PointOut(
        id=point.id,
        map_id=point.map_id,
        layer_id=point.layer_id,
        lat=lat,
        lng=lng,
        title=point.title,
        description=point.description,
        record_type=point.record_type,
        campaign=point.campaign,
        quantity=point.quantity,
        status=point.status,
        last_observed_at=point.last_observed_at,
        removed_at=point.removed_at,
        removal_reason=point.removal_reason,
        removal_confidence=point.removal_confidence,
        removal_note=point.removal_note,
        created_by=point.created_by,
        captured_at=point.captured_at,
        created_at=point.created_at,
        updated_at=point.updated_at,
        client_created_at=point.client_created_at,
        location_accuracy_m=point.location_accuracy_m,
        version=point.version,
        photos=[photo_to_out(photo) for photo in point.photos],
    )


def add_point_event(
    session: Session,
    point: PointRecord,
    event: PointEventCreate,
    actor_id: str,
) -> PointEvent:
    record = PointEvent(
        map_id=point.map_id,
        point_id=point.id,
        event_type=event.event_type,
        occurred_at=event.occurred_at,
        actor_id=actor_id,
        removal_reason=event.removal_reason,
        removal_confidence=event.removal_confidence,
        note=event.note,
    )
    session.add(record)
    return record


def add_sync_event(
    session: Session,
    map_id: UUID,
    entity_type: str,
    entity_id: UUID,
    action: str,
    version: int,
    actor_id: str,
) -> None:
    session.add(
        SyncEvent(
            map_id=map_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            version=version,
            actor_id=actor_id,
        )
    )


def storage_path(upload_dir: Path, storage_key: str) -> Path:
    root = upload_dir.resolve()
    path = (root / storage_key).resolve()
    if path.parent != root:
        raise ValueError("Invalid generated storage key")
    return path


def get_point_for_user(
    session: Session, point_id: UUID, include_deleted: bool = False
) -> Optional[PointRecord]:
    statement = select(PointRecord).where(PointRecord.id == point_id)
    if not include_deleted:
        statement = statement.where(PointRecord.deleted_at.is_(None))
    return session.scalar(statement)


def get_photo(session: Session, photo_id: UUID) -> Optional[PhotoRecord]:
    return session.get(PhotoRecord, photo_id)
