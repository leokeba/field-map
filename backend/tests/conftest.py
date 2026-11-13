import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import Settings, get_settings
from app.database import get_db
from app.main import app
from app.models import Base


@pytest.fixture(scope="session")
def database_url() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql+psycopg://fieldmap:fieldmap-local-only@127.0.0.1:5432/fieldmap_test",
    )


@pytest.fixture(scope="session")
def engine(database_url: str):
    test_engine = create_engine(database_url, pool_pre_ping=True)
    with test_engine.begin() as connection:
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    yield test_engine
    Base.metadata.drop_all(bind=test_engine)
    test_engine.dispose()


@pytest.fixture(autouse=True)
def clean_database(engine):
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


@pytest.fixture
def client(engine, tmp_path):
    test_sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_db():
        with test_sessions() as session:
            yield session

    test_settings = Settings(
        database_url="postgresql+psycopg://fieldmap:fieldmap-local-only@127.0.0.1:5432/fieldmap_test",
        upload_dir=tmp_path / "uploads",
    )
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_settings] = lambda: test_settings
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
