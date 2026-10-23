"""Source tags: enum values for two-level tags (e.g. 光线=强/弱)."""

import sqlalchemy as sa
from alembic import op

revision = "0027_source_tag_values"
down_revision = "0026_pose_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("source_tags") as batch:
        batch.add_column(sa.Column("values", sa.JSON(), nullable=True))
    with op.batch_alter_table("source_image_tags") as batch:
        batch.add_column(sa.Column("value", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("source_image_tags") as batch:
        batch.drop_column("value")
    with op.batch_alter_table("source_tags") as batch:
        batch.drop_column("values")
