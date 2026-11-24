"""Async FTP import state on test datasets.

Revision ID: 0041_test_dataset_import_state
Revises: 0040_algorithm_test_tables
Create Date: 2026-11-25

测试数据集从 FTP 目录/压缩包异步建集的进度列(import_state/import_progress/import_message)。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0041_test_dataset_import_state"
down_revision: str | None = "0040_algorithm_test_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _recreate() -> str:
    # SQLite 加列/建表约束走整表重建;PG 直接 DDL。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    with op.batch_alter_table("test_datasets", recreate=_recreate()) as batch:
        batch.add_column(sa.Column("import_state", sa.String(length=16), nullable=True))
        batch.add_column(sa.Column("import_progress", sa.Float(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("import_message", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("test_datasets", recreate=_recreate()) as batch:
        batch.drop_column("import_message")
        batch.drop_column("import_progress")
        batch.drop_column("import_state")
