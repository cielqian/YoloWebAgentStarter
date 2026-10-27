"""Training tasks: data augmentation params (hsv_h/degrees/mixup/fliplr).

Revision ID: 0034_training_augmentation_params
Revises: 0033_training_include_unannotated
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034_training_augmentation_params"
down_revision: str | None = "0033_training_include_unannotated"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = ("hsv_h", "degrees", "mixup", "fliplr")


def upgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        for column in _COLUMNS:
            batch.add_column(sa.Column(column, sa.Float(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        for column in _COLUMNS:
            batch.drop_column(column)
