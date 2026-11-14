# Field Map

A mobile-first field collection tool for adding timestamped, photo-enabled points to shared maps.

Field Map combines an interactive map with shared layers, protected photo uploads, and offline capture. Changes made offline are stored in the browser and queued for synchronization when connectivity returns.

## Features

- Create, view, edit, and delete timestamped map observations.
- Record poster placements with campaign and quantity, then log follow-up observations and removals with event times, reasons, confidence, and notes.
- Run a one-tap campaign mode with a live camera view that saves a poster — photo and GPS position included — from a single capture, with repeat captures until you close it.
- Review a placement's event history; poster lifecycle updates queue offline and synchronize with point edits.
- Create and switch between maps; owners can permanently delete a map and all its data.
- Create layers, choose where new points go, toggle layer visibility, and delete layers with their points and photos as an owner.
- Protect maps with member roles or private links.
- Share separate owner, editor, and viewer links; rotate a link to revoke its previous token.
- Attach photos with size and image-dimension limits.
- Cache map data and queue point and photo changes locally for later synchronization.
- Detect stale edits and expose a conflict-resolution flow.

## Repository audit and decisions

The repository was empty before Phase 1. There were no Community Stack conventions, existing identity system, deployment configuration, or data services to reuse.

- The frontend uses Vue 3, TypeScript, Vite, and Leaflet. Leaflet was selected for the initial lightweight mobile interaction prototype; MapLibre should be reconsidered before committing to a production renderer.
- The standalone API uses FastAPI, SQLAlchemy, Alembic, and PostgreSQL/PostGIS. The workspace does not define or assume an identity provider.
- Authentication supports a trusted reverse proxy or anonymous map links. Development uses a local identity and a development-only identity header; production never accepts that header.
- Photos are kept on local disk under generated names. The API normalizes uploaded images and strips embedded metadata before storing originals and thumbnails; both require map authorization. Storage and database are not yet wired into Community Stack backup/restore.
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

The client compresses photos larger than 2 MB to a 2048-pixel maximum JPEG before queuing them. Set `VITE_PRESERVE_ORIGINALS=true` to skip client-side compression; the API still normalizes uploaded images and strips embedded metadata before storage. If the Vite app is opened on a phone over the local network, its `/api` requests are proxied to the local API.

## Community Stack integration

The [Community Stack deployment guide](./deploy/community-stack/README.md) includes a production image, Compose stack, and Caddy site snippet. The default deployment allows anonymous map creation and uses private owner/editor/viewer links; no identity provider is required. Trusted-proxy identity is optional.

Private URLs are bearer credentials: anyone who has a link can use its role, so share them carefully. The database stores token hashes, but the owner link is returned only when a map is created or an owner link is rotated. Rotating a link revokes the old token; it cannot erase map data already cached in a browser. Anonymous map creation should be paired with edge-level rate limiting and appropriate resource limits before public exposure.

## Current scope

The mobile map flow supports timestamped poster placements, campaign and quantity capture, one-tap live-camera campaign recording, follow-up observations, and removal events with history. Lifecycle updates work offline and sync through the existing retry and conflict flows. GeoJSON, Community Stack CLI provisioning/backup integration, and identity-provider configuration remain future work.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
