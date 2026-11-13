"""Add role-scoped private map link hashes."""

from alembic import op
import sqlalchemy as sa

revision = "0002_private_map_links"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("maps")}
    for name in ("owner_share_hash", "editor_share_hash", "viewer_share_hash"):
        if name not in columns:
            op.add_column("maps", sa.Column(name, sa.String(length=64), nullable=True))

    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("maps")}
    for name in ("owner_share_hash", "editor_share_hash", "viewer_share_hash"):
        index_name = f"ix_maps_{name}"
        if index_name not in indexes:
            op.create_index(index_name, "maps", [name], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("maps")}
    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("maps")}
    for name in ("owner_share_hash", "editor_share_hash", "viewer_share_hash"):
        index_name = f"ix_maps_{name}"
        if index_name in indexes:
            op.drop_index(index_name, table_name="maps")
    for name in ("owner_share_hash", "editor_share_hash", "viewer_share_hash"):
        if name in columns:
            op.drop_column("maps", name)
