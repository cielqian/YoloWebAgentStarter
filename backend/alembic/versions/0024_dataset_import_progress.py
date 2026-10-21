"""Dataset archive import: async state and progress columns."""

import sqlalchemy as sa
from alembic import op

revision = "0024_dataset_import_progress"
down_revision = "0023_remote_training"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.add_column(sa.Column("import_state", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("import_progress", sa.Float(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("import_message", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.drop_column("import_message")
        batch.drop_column("import_progress")
        batch.drop_column("import_state")
