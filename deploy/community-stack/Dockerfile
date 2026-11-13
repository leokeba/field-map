FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
ARG VITE_TILE_URL
RUN if [ -n "$VITE_TILE_URL" ]; then npm run build; else env -u VITE_TILE_URL npm run build; fi

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS api
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY backend/app ./app
COPY --from=frontend /build/dist ./app/static
RUN useradd --system --uid 10001 --create-home fieldmap \
    && mkdir -p /data/uploads \
    && chown -R fieldmap:fieldmap /app /data/uploads
ENV PATH="/app/backend/.venv/bin:$PATH" \
    APP_ENVIRONMENT=production \
    UPLOAD_DIR=/data/uploads
USER fieldmap
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
