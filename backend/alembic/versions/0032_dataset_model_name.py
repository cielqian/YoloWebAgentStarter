"""Datasets: default produced-model name attribute.

Revision ID: 0032_dataset_model_name
Revises: 0031_training_dataset_version
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032_dataset_model_name"
down_revision: str | None = "0031_training_dataset_version"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.add_column(sa.Column("model_name", sa.String(length=255), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("datasets") as batch:
        batch.drop_column("model_name")
