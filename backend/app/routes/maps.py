from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth import Principal, get_current_user
from app.config import Settings, get_settings
from app.database import get_db
from app.models import (
    LayerRecord,
    MapMembership,
    MapRecord,
    PhotoRecord,
    PointRecord,
    SyncEvent,
)
from app.permissions import require_map_role
from app.schemas import (
    LayerCreate,
    LayerOut,
    LayerPatch,
    MapCreate,
    MapOut,
    MapPatch,
    MemberCreate,
    MemberOut,
    PointCreate,
    PointOut,
    SyncEventOut,
)
from app.services import add_sync_event, point_to_out, storage_path

router = APIRouter(prefix="/api", tags=["maps"])


@router.get("/maps", response_model=list[MapOut])
def list_maps(
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> list[MapRecord]:
    return list(
        session.scalars(
            select(MapRecord)
            .outerjoin(MapMembership, MapMembership.map_id == MapRecord.id)
            .where(
                or_(
                    MapMembership.user_id == user.user_id,
                    MapRecord.visibility == "public",
                )
            )
            .order_by(MapRecord.updated_at.desc())
        )
    )


@router.post("/maps", response_model=MapOut, status_code=status.HTTP_201_CREATED)
def create_map(
    body: MapCreate,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> MapRecord:
    map_record = MapRecord(
        name=body.name.strip(),
        description=body.description,
        visibility="private",
        created_by=user.user_id,
    )
    map_record.memberships.append(
        MapMembership(user_id=user.user_id, role="owner")
    )
    map_record.layers.append(LayerRecord(name="Observations", color="#318b69"))
    session.add(map_record)
    session.commit()
    session.refresh(map_record)
    return map_record


@router.get("/maps/{map_id}", response_model=MapOut)
def get_map(
    map_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> MapRecord:
    return require_map_role(session, map_id, user)


@router.patch("/maps/{map_id}", response_model=MapOut)
def update_map(
    map_id: UUID,
    body: MapPatch,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> MapRecord:
    map_record = require_map_role(session, map_id, user, "owner")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(map_record, key, value)
    session.commit()
    session.refresh(map_record)
    return map_record


@router.delete("/maps/{map_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_map(
    map_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> None:
    map_record = require_map_role(session, map_id, user, "owner")
    photo_keys = [
        key
        for pair in session.execute(
            select(PhotoRecord.storage_key, PhotoRecord.thumbnail_storage_key)
            .join(PointRecord, PointRecord.id == PhotoRecord.point_id)
            .where(PointRecord.map_id == map_id)
        )
        for key in pair
    ]
    session.delete(map_record)
    session.commit()
    for storage_key in photo_keys:
        try:
            storage_path(settings.upload_dir, storage_key).unlink(missing_ok=True)
        except OSError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Map deleted, but a photo file could not be removed",
            )


@router.post(
    "/maps/{map_id}/members",
    response_model=MemberOut,
    status_code=status.HTTP_201_CREATED,
)
def add_member(
    map_id: UUID,
    body: MemberCreate,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> MapMembership:
    require_map_role(session, map_id, user, "owner")
    membership = session.get(MapMembership, (map_id, body.user_id))
    if membership is None:
        membership = MapMembership(map_id=map_id, user_id=body.user_id, role=body.role)
        session.add(membership)
    else:
        membership.role = body.role
    session.commit()
    session.refresh(membership)
    return membership


@router.get("/maps/{map_id}/layers", response_model=list[LayerOut])
def list_layers(
    map_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> list[LayerRecord]:
    require_map_role(session, map_id, user)
    return list(
        session.scalars(
            select(LayerRecord)
            .where(LayerRecord.map_id == map_id)
            .order_by(LayerRecord.sort_order, LayerRecord.created_at)
        )
    )


@router.post(
    "/maps/{map_id}/layers",
    response_model=LayerOut,
    status_code=status.HTTP_201_CREATED,
)
def create_layer(
    map_id: UUID,
    body: LayerCreate,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> LayerRecord:
    require_map_role(session, map_id, user, "owner")
    layer = LayerRecord(map_id=map_id, **body.model_dump())
    session.add(layer)
    session.commit()
    session.refresh(layer)
    return layer


@router.patch("/layers/{layer_id}", response_model=LayerOut)
def update_layer(
    layer_id: UUID,
    body: LayerPatch,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> LayerRecord:
    layer = session.get(LayerRecord, layer_id)
    if layer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found")
    require_map_role(session, layer.map_id, user, "owner")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(layer, key, value)
    session.commit()
    session.refresh(layer)
    return layer


@router.delete("/layers/{layer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_layer(
    layer_id: UUID,
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> None:
    layer = session.get(LayerRecord, layer_id)
    if layer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Layer not found")
    require_map_role(session, layer.map_id, user, "owner")
    point_count = session.scalar(
        select(func.count()).select_from(PointRecord).where(
            PointRecord.layer_id == layer_id
        )
    )
    if point_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Reassign or delete this layer's points before deleting it",
        )
    session.delete(layer)
    session.commit()


@router.get("/maps/{map_id}/points", response_model=list[PointOut])
def list_points(
    map_id: UUID,
    min_lng: Optional[float] = Query(default=None, ge=-180, le=180),
    min_lat: Optional[float] = Query(default=None, ge=-90, le=90),
    max_lng: Optional[float] = Query(default=None, ge=-180, le=180),
    max_lat: Optional[float] = Query(default=None, ge=-90, le=90),
    layer_id: Optional[list[UUID]] = Query(default=None),
    updated_since: Optional[str] = None,
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> list[PointOut]:
    require_map_role(session, map_id, user)
    bounds = (min_lng, min_lat, max_lng, max_lat)
    if any(value is not None for value in bounds) and any(value is None for value in bounds):
        raise HTTPException(status_code=400, detail="Provide all four bounding-box coordinates")
    statement = select(PointRecord).where(
        PointRecord.map_id == map_id, PointRecord.deleted_at.is_(None)
    )
    if all(value is not None for value in bounds):
        if min_lng >= max_lng or min_lat >= max_lat:
            raise HTTPException(status_code=400, detail="Invalid bounding box")
        statement = statement.where(
            func.ST_Intersects(
                PointRecord.geom,
                func.ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326),
            )
        )
    if layer_id:
        statement = statement.where(PointRecord.layer_id.in_(layer_id))
    if updated_since:
        from datetime import datetime

        try:
            cursor = datetime.fromisoformat(updated_since.replace("Z", "+00:00"))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Invalid updated_since timestamp") from error
        statement = statement.where(PointRecord.updated_at > cursor)
    statement = statement.order_by(PointRecord.created_at.desc(), PointRecord.id).limit(limit).offset(offset)
    return [point_to_out(session, point) for point in session.scalars(statement)]


@router.get("/maps/{map_id}/changes", response_model=list[SyncEventOut])
def list_changes(
    map_id: UUID,
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_db),
    user: Principal = Depends(get_current_user),
) -> list[SyncEvent]:
    require_map_role(session, map_id, user)
    return list(
        session.scalars(
            select(SyncEvent)
            .where(SyncEvent.map_id == map_id, SyncEvent.id > after_id)
            .order_by(SyncEvent.id)
            .limit(limit)
        )
    )
