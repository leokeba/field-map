"""In-memory stand-in for the Field Map backend, for local demos only.

Serves the same /api endpoints the frontend uses, backed by in-memory state,
so the app can boot, show a seeded demo map, and accept point/photo uploads
without a PostGIS database. Mirrors the development X-Dev-User flow (no auth).

Run from this directory (the backend project's environment has FastAPI):
    uv run --project ../backend python -m uvicorn mock_api:app --host 127.0.0.1 --port 8001
"""

import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="Field Map mock API (demo)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["*"],
)

MAPS: dict[str, dict] = {}
LAYERS: dict[str, dict] = {}
POINTS: dict[str, dict] = {}
PHOTOS: dict[str, dict] = {}  # photo id -> {meta, bytes}
EVENTS: dict[str, list[dict]] = {}
SHARE_TOKENS: dict[str, str] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def api_point(map_id: str, layer_id: str, lat: float, lng: float, *,
              title: str | None = None, description: str | None = None,
              record_type: str = "poster", campaign: str | None = None,
              quantity: int = 1, status: str | None = "active",
              captured_at: str | None = None, created_by: str = "local-user",
              version: int = 1, accuracy_m: float | None = None,
              client_created_at: str | None = None, photos: list[dict] | None = None) -> dict:
    ts = now()
    return {
        "id": new_id("point"),
        "map_id": map_id,
        "layer_id": layer_id,
        "lat": lat,
        "lng": lng,
        "title": title,
        "description": description,
        "record_type": record_type,
        "campaign": campaign,
        "quantity": quantity,
        "status": status,
        "last_observed_at": captured_at or ts,
        "removed_at": None,
        "removal_reason": None,
        "removal_confidence": None,
        "removal_note": None,
        "created_by": created_by,
        "captured_at": captured_at or ts,
        "created_at": ts,
        "updated_at": ts,
        "client_created_at": client_created_at,
        "location_accuracy_m": accuracy_m,
        "version": version,
        "photos": photos or [],
    }


def seed() -> None:
    map_id = "map-demo"
    MAPS[map_id] = {
        "id": map_id,
        "name": "Demo area",
        "description": "Seeded demo map for the campaign mode walkthrough",
        "visibility": "private",
        "created_by": "local-user",
        "current_role": "owner",
        "created_at": now(),
        "updated_at": now(),
    }
    LAYERS["layer-posters"] = {
        "id": "layer-posters",
        "map_id": map_id,
        "name": "Posters",
        "description": None,
        "color": "#318b69",
        "icon": None,
        "sort_order": 0,
        "is_visible_by_default": True,
        "created_at": now(),
        "updated_at": now(),
    }
    LAYERS["layer-observations"] = {
        "id": "layer-observations",
        "map_id": map_id,
        "name": "Observations",
        "description": None,
        "color": "#e07b39",
        "icon": None,
        "sort_order": 1,
        "is_visible_by_default": True,
        "created_at": now(),
        "updated_at": now(),
    }
    for i, (lat, lng, title, layer_id, record_type) in enumerate([
        (51.5080, -0.1268, "Poster on lamppost", "layer-posters", "poster"),
        (51.5064, -0.1282, "Poster on bus shelter", "layer-posters", "poster"),
        (51.5076, -0.1290, "Flyer bin spot", "layer-observations", "observation"),
    ]):
        point = api_point(
            map_id,
            layer_id,
            lat,
            lng,
            title=title,
            record_type=record_type,
            version=1,
            accuracy_m=12.0,
        )
        POINTS[point["id"]] = point
        if record_type == "poster":
            EVENTS[point["id"]] = [{
                "id": new_id("event"),
                "point_id": point["id"],
                "event_type": "placed",
                "recorded_at": point["captured_at"],
                "actor_id": "local-user",
                "removal_reason": None,
                "removal_confidence": None,
                "note": None,
            }]


seed()


def get_map_or_404(map_id: str) -> dict:
    map_record = MAPS.get(map_id)
    if not map_record:
        raise HTTPException(status_code=404, detail="Map not found")
    return map_record


def get_point_or_404(point_id: str) -> dict:
    point = POINTS.get(point_id)
    if not point:
        raise HTTPException(status_code=404, detail="Point not found")
    return point


def store_events(point_id: str, inputs: list[dict]) -> None:
    for event in inputs:
        EVENTS.setdefault(point_id, []).append({
            "id": new_id("event"),
            "point_id": point_id,
            "event_type": event.get("event_type"),
            "recorded_at": event.get("occurred_at") or now(),
            "actor_id": "local-user",
            "removal_reason": event.get("removal_reason"),
            "removal_confidence": event.get("removal_confidence"),
            "note": event.get("note"),
        })


def photo_ref(photo_id: str, filename: str, mime_type: str, size: int,
              captured_at: str | None) -> dict:
    return {
        "id": photo_id,
        "original_filename": filename,
        "mime_type": mime_type,
        "size_bytes": size,
        "width": 0,
        "height": 0,
        "captured_at": captured_at,
        "uploaded_at": now(),
        "url": f"/api/photos/{photo_id}/file",
        "thumbnail_url": f"/api/photos/{photo_id}/file",
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/maps")
def list_maps() -> list[dict]:
    return sorted(MAPS.values(), key=lambda m: m["updated_at"], reverse=True)


@app.post("/api/maps", status_code=201)
def create_map(payload: dict) -> dict:
    map_id = new_id("map")
    ts = now()
    MAPS[map_id] = {
        "id": map_id,
        "name": payload.get("name") or "Untitled map",
        "description": payload.get("description") or None,
        "visibility": "private",
        "created_by": "local-user",
        "current_role": "owner",
        "created_at": ts,
        "updated_at": ts,
    }
    layer_id = new_id("layer")
    LAYERS[layer_id] = {
        "id": layer_id,
        "map_id": map_id,
        "name": "Default layer",
        "description": None,
        "color": "#318b69",
        "icon": None,
        "sort_order": 0,
        "is_visible_by_default": True,
        "created_at": ts,
        "updated_at": ts,
    }
    token = uuid.uuid4().hex
    SHARE_TOKENS[token] = map_id
    return {"map": MAPS[map_id], "owner_share_token": token}


@app.delete("/api/maps/{map_id}", status_code=204)
def delete_map(map_id: str) -> None:
    get_map_or_404(map_id)
    del MAPS[map_id]
    for layer_id in [l for l, r in LAYERS.items() if r["map_id"] == map_id]:
        del LAYERS[layer_id]
    for point_id in [p for p, r in POINTS.items() if r["map_id"] == map_id]:
        del POINTS[point_id]
        EVENTS.pop(point_id, None)
    for photo_id in [p for p, r in PHOTOS.items() if r["point_id"] == map_id]:
        del PHOTOS[photo_id]


@app.post("/api/maps/{map_id}/share-links/{role}")
def rotate_share_link(map_id: str, role: str) -> dict:
    get_map_or_404(map_id)
    token = uuid.uuid4().hex
    SHARE_TOKENS[token] = map_id
    return {"role": role, "token": token}


@app.get("/api/maps/{map_id}/layers")
def list_layers(map_id: str) -> list[dict]:
    get_map_or_404(map_id)
    return sorted(
        (l for l in LAYERS.values() if l["map_id"] == map_id),
        key=lambda l: l["sort_order"],
    )


@app.post("/api/maps/{map_id}/layers", status_code=201)
def create_layer(map_id: str, payload: dict) -> dict:
    get_map_or_404(map_id)
    layer_id = new_id("layer")
    ts = now()
    LAYERS[layer_id] = {
        "id": layer_id,
        "map_id": map_id,
        "name": payload.get("name") or "Layer",
        "description": None,
        "color": payload.get("color") or "#318b69",
        "icon": None,
        "sort_order": payload.get("sort_order", 0),
        "is_visible_by_default": True,
        "created_at": ts,
        "updated_at": ts,
    }
    return LAYERS[layer_id]


@app.delete("/api/layers/{layer_id}", status_code=204)
def delete_layer(layer_id: str) -> None:
    if layer_id not in LAYERS:
        raise HTTPException(status_code=404, detail="Layer not found")
    del LAYERS[layer_id]
    for point_id in [p for p, r in POINTS.items() if r["layer_id"] == layer_id]:
        del POINTS[point_id]
        EVENTS.pop(point_id, None)


@app.get("/api/maps/{map_id}/points")
def list_points(
    map_id: str,
    min_lng: float | None = Query(default=None),
    min_lat: float | None = Query(default=None),
    max_lng: float | None = Query(default=None),
    max_lat: float | None = Query(default=None),
    limit: int = Query(default=500),
) -> list[dict]:
    get_map_or_404(map_id)
    points = [p for p in POINTS.values() if p["map_id"] == map_id]
    if min_lng is not None:
        points = [p for p in points if p["lng"] >= min_lng]
    if max_lng is not None:
        points = [p for p in points if p["lng"] <= max_lng]
    if min_lat is not None:
        points = [p for p in points if p["lat"] >= min_lat]
    if max_lat is not None:
        points = [p for p in points if p["lat"] <= max_lat]
    return points[:limit]


@app.post("/api/maps/{map_id}/points", status_code=201)
def create_point(map_id: str, payload: dict) -> dict:
    get_map_or_404(map_id)
    point = api_point(
        map_id,
        payload.get("layer_id"),
        payload["lat"],
        payload["lng"],
        title=payload.get("title"),
        description=payload.get("description"),
        record_type=payload.get("record_type") or "poster",
        campaign=payload.get("campaign"),
        quantity=payload.get("quantity", 1),
        status=payload.get("status"),
        captured_at=payload.get("captured_at"),
        client_created_at=payload.get("client_created_at"),
        accuracy_m=payload.get("location_accuracy_m"),
    )
    # Honour a client-provided id when present (offline-first sync keeps local ids).
    if payload.get("id"):
        point["id"] = payload["id"]
    POINTS[point["id"]] = point
    store_events(point["id"], payload.get("poster_events") or [])
    return point


@app.get("/api/points/{point_id}")
def get_point(point_id: str) -> dict:
    return get_point_or_404(point_id)


@app.patch("/api/points/{point_id}")
def update_point(point_id: str, payload: dict) -> dict:
    point = get_point_or_404(point_id)
    expected = payload.get("expected_version")
    if expected is not None and expected != point["version"]:
        raise HTTPException(status_code=409, detail="Version conflict")
    for field, key in (
        ("layer_id", "layer_id"),
        ("lat", "lat"),
        ("lng", "lng"),
        ("title", "title"),
        ("description", "description"),
        ("captured_at", "captured_at"),
        ("location_accuracy_m", "location_accuracy_m"),
        ("campaign", "campaign"),
        ("quantity", "quantity"),
    ):
        if field in payload:
            point[key] = payload[field]
    point["updated_at"] = now()
    point["version"] += 1
    store_events(point_id, payload.get("poster_events") or [])
    return point


@app.delete("/api/points/{point_id}", status_code=204)
def delete_point(point_id: str, expected_version: int = Query(default=None)) -> None:
    point = get_point_or_404(point_id)
    if expected_version is not None and expected_version != point["version"]:
        raise HTTPException(status_code=409, detail="Version conflict")
    del POINTS[point_id]
    EVENTS.pop(point_id, None)
    for photo_id in [p for p, r in PHOTOS.items() if r["point_id"] == point_id]:
        del PHOTOS[photo_id]


@app.get("/api/points/{point_id}/events")
def get_point_events(point_id: str) -> list[dict]:
    get_point_or_404(point_id)
    return EVENTS.get(point_id, [])


@app.post("/api/points/{point_id}/photos")
async def upload_photo(
    point_id: str,
    file: UploadFile = File(...),
    expected_version: str = Form(...),
    captured_at: str | None = Form(default=None),
) -> dict:
    point = get_point_or_404(point_id)
    if int(expected_version) != point["version"]:
        raise HTTPException(status_code=409, detail="Version conflict")
    data = await file.read()
    photo_id = new_id("photo")
    PHOTOS[photo_id] = {
        "point_id": point_id,
        "meta": photo_ref(photo_id, file.filename or "photo.jpg", file.content_type or "image/jpeg", len(data), captured_at),
        "bytes": data,
    }
    point["photos"].append(PHOTOS[photo_id]["meta"])
    point["updated_at"] = now()
    point["version"] += 1
    return {"id": photo_id, "point_version": point["version"]}


@app.get("/api/photos/{photo_id}/file")
def get_photo_file(photo_id: str) -> Response:
    photo = PHOTOS.get(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    return Response(photo["bytes"], media_type=photo["meta"]["mime_type"])


@app.delete("/api/photos/{photo_id}", status_code=204)
def delete_photo(photo_id: str, expected_version: int = Query(default=None)) -> None:
    photo = PHOTOS.get(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    point = POINTS.get(photo["point_id"])
    if point:
        point["photos"] = [p for p in point["photos"] if p["id"] != photo_id]
        point["updated_at"] = now()
        point["version"] += 1
    del PHOTOS[photo_id]


@app.get("/api/maps/{map_id}/changes")
def get_changes(map_id: str, after_id: int = Query(default=0), limit: int = Query(default=500)) -> list[dict]:
    get_map_or_404(map_id)
    return []
