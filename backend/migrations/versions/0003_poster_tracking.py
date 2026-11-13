"""Add poster lifecycle fields and event history."""

from alembic import op
import sqlalchemy as sa

revision = "0003_poster_tracking"
down_revision = "0002_private_map_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    point_columns = {column["name"] for column in inspector.get_columns("points")}
    for column in (
        sa.Column(
            "record_type",
            sa.String(length=16),
            nullable=False,
            server_default="observation",
        ),
        sa.Column("campaign", sa.String(length=160), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(length=16), nullable=True),
        sa.Column("last_observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removal_reason", sa.String(length=32), nullable=True),
        sa.Column("removal_confidence", sa.String(length=16), nullable=True),
        sa.Column("removal_note", sa.Text(), nullable=True),
    ):
        if column.name not in point_columns:
            op.add_column("points", column)

    point_constraints = {
        constraint["name"]
        for constraint in inspector.get_check_constraints("points")
    }
    for name, condition in (
        ("ck_points_record_type", "record_type IN ('poster', 'observation')"),
        ("ck_points_quantity", "quantity >= 1"),
        ("ck_points_status", "status IS NULL OR status IN ('active', 'removed')"),
    ):
        if name not in point_constraints:
            op.create_check_constraint(name, "points", condition)

    if not inspector.has_table("point_events"):
        op.create_table(
            "point_events",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("map_id", sa.Uuid(), nullable=False),
            sa.Column("point_id", sa.Uuid(), nullable=False),
            sa.Column("event_type", sa.String(length=16), nullable=False),
            sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("actor_id", sa.String(length=128), nullable=False),
            sa.Column("removal_reason", sa.String(length=32), nullable=True),
            sa.Column("removal_confidence", sa.String(length=16), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column(
                "recorded_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.CheckConstraint(
                "event_type IN ('placed', 'observed', 'removed')",
                name="ck_point_events_type",
            ),
            sa.CheckConstraint(
                "removal_reason IS NULL OR removal_reason IN "
                "('suspected_opposition', 'weather', 'property_owner', 'other', 'unknown')",
                name="ck_point_events_removal_reason",
            ),
            sa.CheckConstraint(
                "removal_confidence IS NULL OR removal_confidence IN "
                "('suspected', 'confirmed', 'unknown')",
                name="ck_point_events_removal_confidence",
            ),
            sa.ForeignKeyConstraint(["map_id"], ["maps.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["point_id"], ["points.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )

    event_indexes = (
        ("ix_point_events_map_id", ["map_id"]),
        ("ix_point_events_point_id", ["point_id"]),
    )
    existing_indexes = (
        {index["name"] for index in inspector.get_indexes("point_events")}
        if inspector.has_table("point_events")
        else set()
    )
    for name, columns in event_indexes:
        if name not in existing_indexes:
            op.create_index(name, "point_events", columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("point_events"):
        indexes = {index["name"] for index in inspector.get_indexes("point_events")}
        for name in ("ix_point_events_point_id", "ix_point_events_map_id"):
            if name in indexes:
                op.drop_index(name, table_name="point_events")
        op.drop_table("point_events")
    constraints = {
        constraint["name"]
        for constraint in inspector.get_check_constraints("points")
    }
    for name in ("ck_points_status", "ck_points_quantity", "ck_points_record_type"):
        if name in constraints:
            op.drop_constraint(name, "points", type_="check")
    columns = {column["name"] for column in inspector.get_columns("points")}
    for column in (
        "removal_note",
        "removal_confidence",
        "removal_reason",
        "removed_at",
        "last_observed_at",
        "status",
        "quantity",
        "campaign",
        "record_type",
    ):
        if column in columns:
            op.drop_column("points", column)
