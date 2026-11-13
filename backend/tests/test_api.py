from io import BytesIO
from uuid import UUID, uuid4

from PIL import Image

from app.config import Settings, get_settings


def create_map(client, user="alice"):
    response = client.post(
        "/api/maps",
        headers={"X-Dev-User": user},
        json={"name": "Field notes"},
    )
    assert response.status_code == 201
    created = response.json()
    return {**created["map"], "owner_share_token": created["owner_share_token"]}


def create_point(client, map_record, layer, user="alice", point_id=None):
    point_id = point_id or str(uuid4())
    response = client.post(
        "/api/maps/{0}/points".format(map_record["id"]),
        headers={"X-Dev-User": user},
        json={
            "id": point_id,
            "layer_id": layer["id"],
            "lat": 51.5,
            "lng": -0.12,
            "title": "Field observation",
            "captured_at": "2026-11-13T10:00:00Z",
            "client_created_at": "2026-11-13T09:59:30Z",
            "location_accuracy_m": 7.5,
        },
    )
    assert response.status_code == 201
    return response.json()


def test_private_maps_spatial_queries_idempotency_and_conflicts(client):
    map_record = create_map(client)
    assert map_record["visibility"] == "private"
    assert client.get(
        "/api/maps/{0}".format(map_record["id"]), headers={"X-Dev-User": "bob"}
    ).status_code == 404

    layer = client.get(
        "/api/maps/{0}/layers".format(map_record["id"]),
        headers={"X-Dev-User": "alice"},
    ).json()[0]
    point_id = str(uuid4())
    point = create_point(client, map_record, layer, point_id=point_id)
    assert point["lat"] == 51.5
    assert point["lng"] == -0.12
    assert point["location_accuracy_m"] == 7.5

    retry = create_point(client, map_record, layer, point_id=point_id)
    assert retry["id"] == point_id
    assert retry["version"] == 1

    visible = client.get(
        "/api/maps/{0}/points".format(map_record["id"]),
        headers={"X-Dev-User": "alice"},
        params={"min_lng": -0.2, "min_lat": 51.4, "max_lng": 0.1, "max_lat": 51.6},
    )
    assert visible.status_code == 200
    assert [item["id"] for item in visible.json()] == [point_id]

    outside = client.get(
        "/api/maps/{0}/points".format(map_record["id"]),
        headers={"X-Dev-User": "alice"},
        params={"min_lng": 5, "min_lat": 51.4, "max_lng": 6, "max_lat": 51.6},
    )
    assert outside.json() == []

    updated = client.patch(
        "/api/points/{0}".format(point_id),
        headers={"X-Dev-User": "alice"},
        json={"expected_version": 1, "title": "Updated field note"},
    )
    assert updated.status_code == 200
    assert updated.json()["version"] == 2
    conflict = client.patch(
        "/api/points/{0}".format(point_id),
        headers={"X-Dev-User": "alice"},
        json={"expected_version": 1, "title": "Stale edit"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["current_version"] == 2

    events = client.get(
        "/api/maps/{0}/changes".format(map_record["id"]),
        headers={"X-Dev-User": "alice"},
    )
    assert [event["action"] for event in events.json()] == ["created", "updated"]


def test_poster_lifecycle_records_placement_observation_and_removal(client):
    map_record = create_map(client)
    headers = {"X-Dev-User": "alice"}
    layer = client.get(
        f"/api/maps/{map_record['id']}/layers", headers=headers
    ).json()[0]
    point = create_point(client, map_record, layer)

    assert point["record_type"] == "poster"
    assert point["status"] == "active"
    assert point["quantity"] == 1
    initial_events = client.get(f"/api/points/{point['id']}/events", headers=headers)
    assert initial_events.status_code == 200
    assert [event["event_type"] for event in initial_events.json()] == ["placed"]

    observed_at = "2026-11-14T08:30:00Z"
    observed = client.patch(
        f"/api/points/{point['id']}",
        headers=headers,
        json={
            "expected_version": point["version"],
            "poster_events": [
                {"event_type": "observed", "occurred_at": observed_at}
            ],
        },
    )
    assert observed.status_code == 200
    assert observed.json()["last_observed_at"] == observed_at

    removed_at = "2026-11-15T10:45:00Z"
    removed = client.patch(
        f"/api/points/{point['id']}",
        headers=headers,
        json={
            "expected_version": observed.json()["version"],
            "poster_events": [
                {
                    "event_type": "removed",
                    "occurred_at": removed_at,
                    "removal_reason": "suspected_opposition",
                    "removal_confidence": "suspected",
                    "note": "The poster was gone when checked.",
                }
            ],
        },
    )
    assert removed.status_code == 200
    assert removed.json()["status"] == "removed"
    assert removed.json()["removed_at"] == removed_at

    history = client.get(f"/api/points/{point['id']}/events", headers=headers).json()
    assert [event["event_type"] for event in history] == [
        "placed",
        "observed",
        "removed",
    ]
    assert history[-1]["removal_reason"] == "suspected_opposition"
    assert history[-1]["removal_confidence"] == "suspected"

    repeated_removal = client.patch(
        f"/api/points/{point['id']}",
        headers=headers,
        json={
            "expected_version": removed.json()["version"],
            "poster_events": [
                {"event_type": "removed", "occurred_at": removed_at}
            ],
        },
    )
    assert repeated_removal.status_code == 409


def test_membership_roles_and_layers_protect_data(client):
    map_record = create_map(client)
    owner_headers = {"X-Dev-User": "alice"}
    map_id = map_record["id"]
    layer = client.get(
        "/api/maps/{0}/layers".format(map_id), headers=owner_headers
    ).json()[0]

    added = client.post(
        "/api/maps/{0}/members".format(map_id),
        headers=owner_headers,
        json={"user_id": "viewer", "role": "viewer"},
    )
    assert added.status_code == 201
    assert client.get(
        "/api/maps/{0}".format(map_id), headers={"X-Dev-User": "viewer"}
    ).status_code == 200
    assert client.post(
        "/api/maps/{0}/points".format(map_id),
        headers={"X-Dev-User": "viewer"},
        json={
            "id": str(uuid4()),
            "layer_id": layer["id"],
            "lat": 51.5,
            "lng": -0.12,
        },
    ).status_code == 403

    client.post(
        "/api/maps/{0}/members".format(map_id),
        headers=owner_headers,
        json={"user_id": "editor", "role": "editor"},
    )
    point = create_point(client, map_record, layer, user="editor")
    assert point["created_by"] == "editor"

    assert client.delete(
        "/api/layers/{0}".format(layer["id"]), headers=owner_headers
    ).status_code == 409
    assert client.delete(
        "/api/points/{0}".format(point["id"]),
        headers={"X-Dev-User": "editor"},
        params={"expected_version": point["version"]},
    ).status_code == 204
    assert client.delete(
        "/api/layers/{0}".format(layer["id"]), headers=owner_headers
    ).status_code == 409


def test_delete_empty_layer_and_preserve_one_layer_per_map(client):
    map_record = create_map(client)
    headers = {"X-Dev-User": "alice"}
    map_id = map_record["id"]
    first_layer = client.get(
        f"/api/maps/{map_id}/layers", headers=headers
    ).json()[0]
    second_layer = client.post(
        f"/api/maps/{map_id}/layers",
        headers=headers,
        json={"name": "Temporary"},
    )
    assert second_layer.status_code == 201

    assert client.delete(
        f"/api/layers/{second_layer.json()['id']}", headers=headers
    ).status_code == 204
    last_layer_delete = client.delete(
        f"/api/layers/{first_layer['id']}", headers=headers
    )
    assert last_layer_delete.status_code == 409
    assert last_layer_delete.json()["detail"] == "A map must keep at least one layer"

def test_delete_layer_removes_points_and_emits_sync_deletions(client):
    map_record = create_map(client)
    headers = {"X-Dev-User": "alice"}
    map_id = map_record["id"]
    first_layer = client.get(
        f"/api/maps/{map_id}/layers", headers=headers
    ).json()[0]
    second_layer = client.post(
        f"/api/maps/{map_id}/layers",
        headers=headers,
        json={"name": "Temporary"},
    ).json()
    deleted_point = create_point(client, map_record, second_layer)
    active_point = create_point(client, map_record, second_layer)
    image = Image.new("RGB", (32, 24), color="forestgreen")
    image_bytes = BytesIO()
    image.save(image_bytes, format="PNG")
    uploaded_photo = client.post(
        f"/api/points/{active_point['id']}/photos",
        headers=headers,
        data={"expected_version": str(active_point["version"])},
        files={"file": ("layer-photo.png", image_bytes.getvalue(), "image/png")},
    )
    assert uploaded_photo.status_code == 201
    upload_dir = client.app.dependency_overrides[get_settings]().upload_dir
    photo_id = UUID(uploaded_photo.json()["id"])
    original_file = upload_dir / f"{photo_id.hex}.png"
    thumbnail_file = upload_dir / f"{photo_id.hex}-thumb.jpg"
    assert original_file.is_file()
    assert thumbnail_file.is_file()
    assert client.delete(
        f"/api/points/{deleted_point['id']}",
        headers=headers,
        params={"expected_version": deleted_point["version"]},
    ).status_code == 204

    response = client.delete(f"/api/layers/{second_layer['id']}", headers=headers)

    assert response.status_code == 204
    assert client.get(
        f"/api/maps/{map_id}/layers", headers=headers
    ).json() == [first_layer]
    assert client.get(f"/api/maps/{map_id}/points", headers=headers).json() == []
    assert not original_file.exists()
    assert not thumbnail_file.exists()
    changes = client.get(f"/api/maps/{map_id}/changes", headers=headers).json()
    for point in (deleted_point, active_point):
        point_changes = [event for event in changes if event["entity_id"] == point["id"]]
        assert point_changes[-1]["action"] == "deleted"


def test_delete_map_removes_its_layers_and_points(client):
    map_record = create_map(client)
    headers = {"X-Dev-User": "alice"}
    layer = client.get(
        f"/api/maps/{map_record['id']}/layers", headers=headers
    ).json()[0]
    create_point(client, map_record, layer)

    response = client.delete(f"/api/maps/{map_record['id']}", headers=headers)

    assert response.status_code == 204
    assert client.get(f"/api/maps/{map_record['id']}", headers=headers).status_code == 404
    assert client.get("/api/maps", headers=headers).json() == []


def test_photo_validation_storage_and_private_access(client):
    map_record = create_map(client)
    headers = {"X-Dev-User": "alice"}
    layer = client.get(
        "/api/maps/{0}/layers".format(map_record["id"]), headers=headers
    ).json()[0]
    point = create_point(client, map_record, layer)

    image = Image.new("RGB", (800, 400), color="forestgreen")
    exif = Image.Exif()
    exif[270] = "Sensitive location metadata"
    image_bytes = BytesIO()
    image.save(image_bytes, format="JPEG", exif=exif)
    upload = client.post(
        "/api/points/{0}/photos".format(point["id"]),
        headers=headers,
        data={"expected_version": str(point["version"])},
        files={"file": ("unsafe name.jpg", image_bytes.getvalue(), "image/jpeg")},
    )
    assert upload.status_code == 201
    photo = upload.json()
    assert photo["width"] == 800
    assert photo["mime_type"] == "image/jpeg"
    upload_dir = client.app.dependency_overrides[get_settings]().upload_dir
    stored_image = Image.open(upload_dir / f"{UUID(photo['id']).hex}.jpg")
    assert stored_image.getexif().get(270) is None

    denied = client.get(photo["url"], headers={"X-Dev-User": "bob"})
    assert denied.status_code == 404
    thumbnail = client.get(photo["thumbnail_url"], headers=headers)
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"].startswith("image/jpeg")

    invalid = client.post(
        "/api/points/{0}/photos".format(point["id"]),
        headers=headers,
        data={"expected_version": str(photo["point_version"])},
        files={"file": ("fake.jpg", b"not an image", "image/jpeg")},
    )
    assert invalid.status_code == 415

    assert client.delete(
        "/api/photos/{0}".format(photo["id"]),
        headers=headers,
        params={"expected_version": photo["point_version"]},
    ).status_code == 204


def test_production_mode_does_not_accept_development_identity(client):
    production_settings = Settings(app_environment="production")
    client.app.dependency_overrides[get_settings] = lambda: production_settings

    response = client.get("/api/maps", headers={"X-Dev-User": "owner"})

    assert response.status_code == 503
    assert response.json()["detail"] == "Trusted proxy authentication is not configured"


def test_trusted_proxy_identity_requires_valid_secret_and_user(client):
    production_settings = Settings(
        app_environment="production",
        trusted_proxy_secret="proxy-secret",
    )
    client.app.dependency_overrides[get_settings] = lambda: production_settings

    rejected = client.get(
        "/api/maps",
        headers={
            "X-Field-Map-User": "alice",
            "X-Field-Map-Proxy-Secret": "wrong-secret",
        },
    )
    assert rejected.status_code == 401

    accepted = client.get(
        "/api/maps",
        headers={
            "X-Field-Map-User": "alice",
            "X-Field-Map-Proxy-Secret": "proxy-secret",
        },
    )
    assert accepted.status_code == 200
    assert accepted.json() == []


def test_trusted_proxy_identity_rejects_malformed_user_id(client):
    production_settings = Settings(
        app_environment="production",
        trusted_proxy_secret="proxy-secret",
    )
    client.app.dependency_overrides[get_settings] = lambda: production_settings

    response = client.get(
        "/api/maps",
        headers={
            "X-Field-Map-User": "alice!",
            "X-Field-Map-Proxy-Secret": "proxy-secret",
        },
    )

    assert response.status_code == 401


def test_anonymous_private_map_links_are_scoped_by_role_and_revocable(client):
    anonymous_settings = Settings(
        app_environment="production",
        anonymous_links_enabled=True,
    )
    client.app.dependency_overrides[get_settings] = lambda: anonymous_settings

    created = client.post("/api/maps", json={"name": "Anonymous field survey"})
    assert created.status_code == 201
    result = created.json()
    map_record = result["map"]
    owner_headers = {"X-Map-Share-Token": result["owner_share_token"]}

    assert map_record["visibility"] == "private"
    assert map_record["current_role"] == "owner"
    assert "owner_share_hash" not in map_record
    assert client.get("/api/maps", headers=owner_headers).json()[0]["id"] == map_record["id"]

    layer = client.get(
        f"/api/maps/{map_record['id']}/layers",
        headers=owner_headers,
    ).json()[0]
    editor_link = client.post(
        f"/api/maps/{map_record['id']}/share-links/editor",
        headers=owner_headers,
    )
    assert editor_link.status_code == 200
    editor_headers = {"X-Map-Share-Token": editor_link.json()["token"]}
    editor_point = client.post(
        f"/api/maps/{map_record['id']}/points",
        headers=editor_headers,
        json={
            "id": str(uuid4()),
            "layer_id": layer["id"],
            "lat": 51.5,
            "lng": -0.12,
            "title": "Anonymous edit",
        },
    )
    assert editor_point.status_code == 201

    viewer_link = client.post(
        f"/api/maps/{map_record['id']}/share-links/viewer",
        headers=owner_headers,
    )
    assert viewer_link.status_code == 200
    old_viewer_headers = {"X-Map-Share-Token": viewer_link.json()["token"]}
    viewer_map = client.get("/api/maps", headers=old_viewer_headers).json()[0]
    assert viewer_map["current_role"] == "viewer"
    assert client.post(
        f"/api/maps/{map_record['id']}/points",
        headers=old_viewer_headers,
        json={
            "id": str(uuid4()),
            "layer_id": layer["id"],
            "lat": 51.5,
            "lng": -0.12,
            "title": "Unauthorized edit",
        },
    ).status_code == 403
    assert client.post(
        f"/api/maps/{map_record['id']}/members",
        headers=old_viewer_headers,
        json={"user_id": "someone", "role": "viewer"},
    ).status_code == 403

    rotated = client.post(
        f"/api/maps/{map_record['id']}/share-links/viewer",
        headers=owner_headers,
    )
    assert rotated.status_code == 200
    assert client.get("/api/maps", headers=old_viewer_headers).status_code == 401
    assert client.get(
        "/api/maps",
        headers={"X-Map-Share-Token": rotated.json()["token"]},
    ).status_code == 200


def test_anonymous_without_a_private_link_cannot_read_private_maps(client):
    owner_map = create_map(client)
    client.app.dependency_overrides[get_settings] = lambda: Settings(
        app_environment="production",
        anonymous_links_enabled=True,
    )

    assert client.get("/api/maps").json() == []
    assert client.get(f"/api/maps/{owner_map['id']}").status_code == 404
