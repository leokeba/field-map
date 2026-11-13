from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_environment: str = "development"
    database_url: str = (
        "postgresql+psycopg://fieldmap:fieldmap-local-only@127.0.0.1:5432/fieldmap"
    )
    upload_dir: Path = Path("var/uploads")
    max_upload_size_bytes: int = 10_000_000
    development_user_id: str = "local-user"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
