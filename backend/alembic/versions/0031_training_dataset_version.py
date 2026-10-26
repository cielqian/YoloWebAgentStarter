"""Training tasks: record the dataset version used for training.

Revision ID: 0031_training_dataset_version
Revises: 0030_model_converting_status
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031_training_dataset_version"
down_revision: str | None = "0030_model_converting_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.add_column(sa.Column("dataset_version_number", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.drop_column("dataset_version_number")
