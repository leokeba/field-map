from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from geoalchemy2 import WKTElement
from geoalchemy2.functions import ST_X, ST_Y
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app.auth import Principal, get_current_user
from app.config import Settings, get_settings
from app.database import get_db
from app.models import LayerRecord, PhotoRecord, PointEvent, PointRecord, SyncEvent, utcnow
from app.permissions import require_map_role
from app.schemas import PointCreate, PointEventCreate, PointEventOut, PointOut, PointPatch
from app.services import (
    add_sync_event,
    add_point_event,
    get_photo,
    point_to_out,
    storage_path,
)

router = APIRouter(prefix="/api", tags=["points", "photos"])
IMAGE_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
}
MAX_IMAGE_DIMENSION = 12000
MAX_IMAGE_PIXELS = 40000000


def load_point(
    session: Session,
    point_id: UUID,
    user: Principal,
    minimum_role: str = "viewer",
    for_update: bool = False,
) -> PointRecord:
    statement = (
        select(PointRecord)
        .options(selectinload(PointRecord.photos))
        .where(PointRecord.id == point_id, PointRecord.deleted_at.is_(None))
    )
    if for_update:
        statement = statement.with_for_update()
    point = session.scalar(statement)
    if point is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Point not found")
    require_map_role(session, point.map_id, user, minimum_role)
    return point


def record_poster_event(
    session: Session,
    point: PointRecord,
    event: PointEventCreate,
    actor_id: str,
) -> PointEvent:
    if point.record_type != "poster":
        raise HTTPException(status_code=409, detail="Only poster placements have lifecycle events")
    if point.status != "active":
        raise HTTPException(status_code=409, detail="A removed poster cannot receive new events")
    if event.event_type == "observed":
        point.last_observed_at = event.occurred_at
    else:
        point.status = "removed"
        point.removed_at = event.occurred_at
        point.removal_reason = event.removal_reason or "unknown"
        point.removal_confidence = event.removal_confidence or "unknown"
        point.removal_note = event.note
    return add_point_event(session, point, event, actor_id)


@router.post("/maps/{map_id}/points", response_model=PointOut, status_code=201)
def create_point(
    map_id: UUID,
    body: PointCreate,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> PointOut:
    require_map_role(session, map_id, user, "editor")
    existing = session.get(PointRecord, body.id)
    if existing is not None:
        if existing.map_id != map_id or existing.created_by != user.user_id:
            raise HTTPException(status_code=409, detail="Point identifier is already in use")
        if existing.deleted_at is not None:
            raise HTTPException(status_code=409, detail="Point was already deleted")
        return point_to_out(session, existing)

    layer = session.get(LayerRecord, body.layer_id)
    if layer is None or layer.map_id != map_id:
        raise HTTPException(status_code=422, detail="Layer must belong to this map")
    point = PointRecord(
        id=body.id,
        map_id=map_id,
        layer_id=body.layer_id,
        geom=WKTElement("POINT({0} {1})".format(body.lng, body.lat), srid=4326),
        title=body.title,
        description=body.description,
        record_type=body.record_type,
        campaign=body.campaign,
        quantity=body.quantity,
        status="active" if body.record_type == "poster" else None,
        last_observed_at=body.captured_at if body.record_type == "poster" else None,
        created_by=user.user_id,
        captured_at=body.captured_at,
        client_created_at=body.client_created_at,
        location_accuracy_m=body.location_accuracy_m,
        version=1,
    )
    session.add(point)
    if body.record_type == "poster":
        session.add(
            PointEvent(
                map_id=map_id,
                point_id=point.id,
                event_type="placed",
                occurred_at=body.captured_at,
                actor_id=user.user_id,
            )
        )
        for event in body.poster_events:
            record_poster_event(session, point, event, user.user_id)
        if body.status == "removed" and point.status != "removed":
            raise HTTPException(
                status_code=422,
                detail="A removed poster requires a removal event",
            )
        if body.status == "active" and point.status != "active":
            raise HTTPException(status_code=422, detail="Poster status does not match its events")
    elif body.poster_events or body.status or body.removed_at:
        raise HTTPException(
            status_code=422,
            detail="Observation records cannot include poster lifecycle data",
        )
    add_sync_event(session, map_id, "point", point.id, "created", 1, user.user_id)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        existing = session.get(PointRecord, body.id)
        if (
            existing is not None
            and existing.map_id == map_id
            and existing.created_by == user.user_id
            and existing.deleted_at is None
        ):
            return point_to_out(session, existing)
        raise HTTPException(status_code=409, detail="Point identifier is already in use") from error
    session.refresh(point)
    return point_to_out(session, point)


@router.get("/points/{point_id}", response_model=PointOut)
def get_point(
    point_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> PointOut:
    return point_to_out(session, load_point(session, point_id, user))


@router.patch("/points/{point_id}", response_model=PointOut)
def update_point(
    point_id: UUID,
    body: PointPatch,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> PointOut:
    point = load_point(session, point_id, user, "editor", for_update=True)
    if point.version != body.expected_version:
        current = point_to_out(session, point)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Point changed on the server",
                "current_version": point.version,
                "point": current.model_dump(mode="json"),
            },
        )
    if body.poster_events and point.record_type != "poster":
        raise HTTPException(status_code=409, detail="Only poster placements have lifecycle events")
    changes = body.model_dump(
        exclude={"expected_version", "poster_events"},
        exclude_unset=True,
    )
    if "layer_id" in changes:
        layer = session.get(LayerRecord, changes["layer_id"])
        if layer is None or layer.map_id != point.map_id:
            raise HTTPException(status_code=422, detail="Layer must belong to this map")
    if "lat" in changes or "lng" in changes:
        lng, lat = session.execute(
            select(ST_X(PointRecord.geom), ST_Y(PointRecord.geom)).where(
                PointRecord.id == point.id
            )
        ).one()
        changes["geom"] = WKTElement(
            "POINT({0} {1})".format(changes.get("lng", lng), changes.get("lat", lat)),
            srid=4326,
        )
        changes.pop("lat", None)
        changes.pop("lng", None)
    for key, value in changes.items():
        setattr(point, key, value)
    for event in body.poster_events:
        record_poster_event(session, point, event, user.user_id)
    point.version += 1
    point.updated_at = utcnow()
    add_sync_event(
        session, point.map_id, "point", point.id, "updated", point.version, user.user_id
    )
    session.commit()
    session.refresh(point)
    return point_to_out(session, point)


@router.get("/points/{point_id}/events", response_model=list[PointEventOut])
def list_point_events(
    point_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> list[PointEvent]:
    point = load_point(session, point_id, user)
    return list(
        session.scalars(
            select(PointEvent)
            .where(PointEvent.point_id == point.id)
            .order_by(PointEvent.recorded_at, PointEvent.id)
        )
    )


@router.delete("/points/{point_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_point(
    point_id: UUID,
    expected_version: int = Query(ge=1),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> None:
    point = load_point(session, point_id, user, "editor", for_update=True)
    if point.version != expected_version:
        current = point_to_out(session, point)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Point changed on the server",
                "current_version": point.version,
                "point": current.model_dump(mode="json"),
            },
        )
    photo_keys: list[str] = []
    for photo in list(point.photos):
        photo_keys.extend([photo.storage_key, photo.thumbnail_storage_key])
        session.delete(photo)
    point.deleted_at = utcnow()
    point.updated_at = utcnow()
    point.version += 1
    add_sync_event(
        session, point.map_id, "point", point.id, "deleted", point.version, user.user_id
    )
    session.commit()
    for storage_key in photo_keys:
        try:
            storage_path(settings.upload_dir, storage_key).unlink(missing_ok=True)
        except OSError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Point deleted, but a photo file could not be removed",
            )


@router.post("/points/{point_id}/photos", status_code=status.HTTP_201_CREATED)
def upload_photo(
    point_id: UUID,
    file: UploadFile = File(...),
    expected_version: int = Form(..., ge=1),
    captured_at: Optional[datetime] = Form(default=None),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    point = load_point(session, point_id, user, "editor", for_update=True)
    if point.version != expected_version:
        current = point_to_out(session, point)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Point changed on the server",
                "current_version": point.version,
                "point": current.model_dump(mode="json"),
            },
        )
    contents = file.file.read(settings.max_upload_size_bytes + 1)
    if len(contents) > settings.max_upload_size_bytes:
        raise HTTPException(status_code=413, detail="Photo exceeds the upload size limit")
    try:
        image = Image.open(BytesIO(contents))
        image_format = image.format
        if image_format not in IMAGE_FORMATS:
            raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP photos are supported")
        width, height = image.size
        if (
            width > MAX_IMAGE_DIMENSION
            or height > MAX_IMAGE_DIMENSION
            or width * height > MAX_IMAGE_PIXELS
        ):
            raise HTTPException(status_code=413, detail="Photo dimensions exceed the supported limit")
        image.verify()
        image = ImageOps.exif_transpose(Image.open(BytesIO(contents)))
        image.load()
    except Image.DecompressionBombError as error:
        raise HTTPException(status_code=413, detail="Photo dimensions exceed the supported limit") from error
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=415, detail="Uploaded file is not a valid image") from error
    except OSError as error:
        raise HTTPException(status_code=415, detail="Uploaded image could not be decoded") from error

    mime_type, extension = IMAGE_FORMATS[image_format]
    transparency = image.info.get("transparency")
    image.info.clear()
    image.getexif().clear()
    if transparency is not None:
        image.info["transparency"] = transparency
    if image_format == "JPEG" and image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    sanitized_original = BytesIO()
    if image_format in ("JPEG", "WEBP"):
        image.save(sanitized_original, format=image_format, quality=95, optimize=True)
    else:
        image.save(sanitized_original, format=image_format, optimize=True)
    sanitized_contents = sanitized_original.getvalue()
    photo_id = uuid4()
    storage_key = "{0}.{1}".format(photo_id.hex, extension)
    thumbnail_key = "{0}-thumb.jpg".format(photo_id.hex)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    original_path = storage_path(settings.upload_dir, storage_key)
    thumbnail_path = storage_path(settings.upload_dir, thumbnail_key)

    image.thumbnail((640, 640))
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    thumbnail = BytesIO()
    image.save(thumbnail, format="JPEG", quality=78, optimize=True)
    try:
        original_path.write_bytes(sanitized_contents)
        thumbnail_path.write_bytes(thumbnail.getvalue())
        photo = PhotoRecord(
            id=photo_id,
            point_id=point.id,
            storage_key=storage_key,
            thumbnail_storage_key=thumbnail_key,
            original_filename=Path(file.filename or "photo").name[:255],
            mime_type=mime_type,
            size_bytes=len(sanitized_contents),
            width=width,
            height=height,
            captured_at=captured_at,
        )
        session.add(photo)
        point.version += 1
        point.updated_at = utcnow()
        add_sync_event(
            session, point.map_id, "point", point.id, "updated", point.version, user.user_id
        )
        session.commit()
    except (OSError, SQLAlchemyError):
        session.rollback()
        original_path.unlink(missing_ok=True)
        thumbnail_path.unlink(missing_ok=True)
        raise

    session.refresh(photo)
    return {
        "id": str(photo.id),
        "original_filename": photo.original_filename,
        "mime_type": photo.mime_type,
        "size_bytes": photo.size_bytes,
        "width": photo.width,
        "height": photo.height,
        "captured_at": photo.captured_at.isoformat() if photo.captured_at else None,
        "uploaded_at": photo.uploaded_at.isoformat(),
        "url": "/api/photos/{0}".format(photo.id),
        "thumbnail_url": "/api/photos/{0}?thumbnail=true".format(photo.id),
        "point_version": point.version,
    }


@router.get("/photos/{photo_id}")
def get_photo_file(
    photo_id: UUID,
    thumbnail: bool = Query(default=False),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    photo = get_photo(session, photo_id)
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")
    point = load_point(session, photo.point_id, user)
    storage_key = photo.thumbnail_storage_key if thumbnail else photo.storage_key
    path = storage_path(settings.upload_dir, storage_key)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo file not found")
    media_type = "image/jpeg" if thumbnail else photo.mime_type
    return FileResponse(path, media_type=media_type, content_disposition_type="inline")


@router.delete("/photos/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_photo(
    photo_id: UUID,
    expected_version: int = Query(ge=1),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> None:
    photo = get_photo(session, photo_id)
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")
    point = load_point(session, photo.point_id, user, "editor", for_update=True)
    if point.version != expected_version:
        current = point_to_out(session, point)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Point changed on the server",
                "current_version": point.version,
                "point": current.model_dump(mode="json"),
            },
        )
    storage_keys = [photo.storage_key, photo.thumbnail_storage_key]
    session.delete(photo)
    point.version += 1
    point.updated_at = utcnow()
    add_sync_event(
        session, point.map_id, "point", point.id, "updated", point.version, user.user_id
    )
    session.commit()
    for storage_key in storage_keys:
        try:
            storage_path(settings.upload_dir, storage_key).unlink(missing_ok=True)
        except OSError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Photo metadata deleted, but a photo file could not be removed",
            )
