"""Training task params nullable and drop val_ratio.

Revision ID: 0038_training_params
Revises: 0037_material_types
Create Date: 2026-10-30

训练参数留空不再下发:training_tasks 的 epochs/img_size/batch_size/workers/seed 改为可空(留空存 NULL,
由 Ultralytics 运行时默认值接管),并删除不再使用的 val_ratio 列(训练使用已保存的 split,不再按比例切分)。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038_training_params"
down_revision: str | None = "0037_material_types"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NULLABLE_COLUMNS = ("epochs", "img_size", "batch_size", "workers", "seed")


def _recreate() -> str:
    # SQLite 改列约束走整表重建;PG 直接 DDL。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    with op.batch_alter_table("training_tasks", recreate=_recreate()) as batch:
        for column in _NULLABLE_COLUMNS:
            batch.alter_column(column, existing_type=sa.Integer(), nullable=True)
        batch.drop_column("val_ratio")


def downgrade() -> None:
    with op.batch_alter_table("training_tasks", recreate=_recreate()) as batch:
        batch.add_column(sa.Column("val_ratio", sa.Float(), nullable=False, server_default=sa.text("0.2")))
        for column in _NULLABLE_COLUMNS:
            batch.alter_column(column, existing_type=sa.Integer(), nullable=False)
