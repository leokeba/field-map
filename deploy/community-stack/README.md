# Community Stack deployment

This standalone Compose project runs Field Map behind Community Stack's existing Caddy `proxy_net`. It includes its own PostGIS database and persistent photo storage. It does not modify Community Stack or register the service with its provisioning or backup CLI.

## Deploy

1. Clone Field Map on the host running Community Stack.
2. Copy `.env.example` to `.env`. Set `FIELD_MAP_ORIGIN` and replace `FIELD_MAP_DB_PASSWORD` with a long random alphanumeric secret (for example, generate one with `openssl rand -hex 32`).
3. Add the site block from `Caddyfile` to the Community Stack Caddy configuration, replacing `field-map.example.org` with the configured host name.
4. From this directory, build and start the project:

   ```sh
   docker compose up -d --build
   ```

The Compose file expects Community Stack's external Docker network to be named `proxy_net`. The database is not published to the host and is isolated on a private internal network. The app serves the built frontend and API on port 8000; Compose migrations run before the API starts.

## Authentication and sharing

The default enables anonymous map creation. Newly created maps are private and the creator receives an owner URL; owners can generate separate editor and viewer URLs. These URLs are bearer credentials, so anyone holding one gets its role. Set `FIELD_MAP_ANONYMOUS_LINKS_ENABLED=false` to disable anonymous creation; existing share URLs continue to work.

Trusted-proxy authentication is optional. To enable it, set a strong `FIELD_MAP_PROXY_SECRET` and configure an authenticated upstream proxy to send `X-Field-Map-User` and `X-Field-Map-Proxy-Secret` to Field Map. The upstream must remove client-supplied values for both headers and set them only after authenticating the request. Never expose the proxy secret to browsers or place it in a public Caddy site block. Share-link access remains available alongside trusted-proxy identities.

Do not put a login gate in front of the entire site if anonymous private-link sharing is needed: the proxy must allow requests carrying these URLs through. Apply rate limits and request-size limits at the edge before enabling anonymous map creation on a public host.

## Storage and upgrades

Back up both `field-map-postgres` and `field-map-uploads`; database records refer to photo files in the uploads volume. Community Stack's backup CLI does not currently discover these volumes, so configure backups separately and verify a restore before relying on them.

On upgrades, rebuild and recreate the app container with `docker compose up -d --build`. The container applies Alembic migrations during startup. Database schema changes are additive; take a backup before upgrading.

`FIELD_MAP_TILE_URL` is a build-time setting. If omitted, the frontend uses its development default OpenStreetMap tile URL; select a provider and follow its usage policy for production.
