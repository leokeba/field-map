# Field Map

A mobile-first field collection tool for adding timestamped, photo-enabled points to shared maps.

Field Map combines an interactive map with shared layers, protected photo uploads, and offline capture. Changes made offline are stored in the browser and queued for synchronization when connectivity returns.

## Features

- Create, view, edit, and delete timestamped map observations.
- Organize observations into layers and protect private maps with member roles.
- Attach photos with size and image-dimension limits.
- Cache map data and queue point and photo changes locally for later synchronization.
- Detect stale edits and expose a conflict-resolution flow.

## Repository audit and decisions

The repository was empty before Phase 1. There were no Community Stack conventions, existing identity system, deployment configuration, or data services to reuse.

- The frontend uses Vue 3, TypeScript, Vite, and Leaflet. Leaflet was selected for the initial lightweight mobile interaction prototype; MapLibre should be reconsidered before committing to a production renderer.
- The standalone API uses FastAPI, SQLAlchemy, Alembic, and PostgreSQL/PostGIS. The workspace does not define or assume an identity provider.
- Authorization is behind an identity adapter. Local development uses a fixed development identity and an explicitly development-only identity header for role testing. Production refuses requests until a real adapter is configured; it does not trust development headers.
- Photos are kept on local disk under generated names. Original files retain their EXIF metadata but require map authorization; generated thumbnails strip metadata. Storage and database are not yet wired into Community Stack backup/restore.
- The map tile URL is configurable via `VITE_TILE_URL`. The default OpenStreetMap raster URL is for local prototyping only; choose and document a suitable provider before production.
- Collaboration uses polling change cursors rather than a separate realtime service. Offline writes and photo uploads are queued in IndexedDB and retried.

## Run locally

Prerequisites: Node.js/npm, `uv`, and Docker with Compose.

```sh
docker compose up -d db
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

In another terminal:

```sh
npm install
npm run dev -- --host 0.0.0.0
```

The API is available at `http://127.0.0.1:8000`; the Vite app is at `http://127.0.0.1:5173`. Development authentication is local-only. Do not expose this setup to an untrusted network.

Run focused validation with `cd backend && uv run pytest`, `npm test`, and `npm run build`. The API tests use the separate `fieldmap_test` database created on first database initialization; it is not the application database.

The client compresses photos larger than 2 MB to a 2048-pixel maximum JPEG before queuing them. Set `VITE_PRESERVE_ORIGINALS=true` to retain the selected original. If the Vite app is opened on a phone over the local network, its `/api` requests are proxied to the local API.

## Current scope

Phases 1–3 cover the mobile map flow, persistent map/layer/point APIs, private-map membership roles, protected photo uploads, IndexedDB caching and retry queues, optimistic point creation, conflict state, and polling updates. GeoJSON, deployment lifecycle, backups, and production identity-provider integration remain future work.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
