"""Global tag library: reusable tags with enum values, shared by source datasets."""

import sqlalchemy as sa
from alembic import op

revision = "0028_global_tag_library"
down_revision = "0027_source_tag_values"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tag_templates",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=False, server_default="#3157d5"),
        sa.Column("values", sa.JSON(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_tag_template_name"),
    )


def downgrade() -> None:
    op.drop_table("tag_templates")
