from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth import Principal
from app.models import MapMembership, MapRecord

ROLE_LEVEL = {"viewer": 1, "editor": 2, "owner": 3}


def require_map_role(
    session: Session,
    map_id: UUID,
    user: Principal,
    minimum_role: str = "viewer",
) -> MapRecord:
    map_record = session.get(MapRecord, map_id)
    if map_record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Map not found")

    if user.map_id is not None:
        if user.map_id != map_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Map not found")
        if ROLE_LEVEL[user.map_role or "viewer"] < ROLE_LEVEL[minimum_role]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient map role",
            )
        return map_record

    membership: Optional[MapMembership] = session.get(
        MapMembership, (map_id, user.user_id)
    )
    role = membership.role if membership else None
    if role is None and map_record.visibility == "public" and minimum_role == "viewer":
        return map_record
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Map not found")
    if ROLE_LEVEL[role] < ROLE_LEVEL[minimum_role]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient map role")
    return map_record
