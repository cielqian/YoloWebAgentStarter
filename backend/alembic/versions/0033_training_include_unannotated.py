"""Training tasks: include unannotated images (empty labels) as an option.

Revision ID: 0033_training_include_unannotated
Revises: 0032_dataset_model_name
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033_training_include_unannotated"
down_revision: str | None = "0032_dataset_model_name"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.add_column(sa.Column("include_unannotated", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.drop_column("include_unannotated")
