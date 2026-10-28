"""Model version ids: widen String(64) to String(128).

Revision ID: 0035_model_version_id_length
Revises: 0034_training_augmentation_params
Create Date: 2026-10-28

长血缘链派生的模型版本 id 会超过 64 字符(SQLite 不校验长度,PostgreSQL 严格校验)。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035_model_version_id_length"
down_revision: str | None = "0034_training_augmentation_params"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _recreate() -> str:
    # SQLite 改列类型必须整表重建;PG 直接 ALTER。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    with op.batch_alter_table("model_versions", recreate=_recreate()) as batch:
        batch.alter_column("id", existing_type=sa.String(64), type_=sa.String(128), nullable=False)
        batch.alter_column("source_model_id", existing_type=sa.String(64), type_=sa.String(128))
    for table in ("model_test_records", "model_evaluation_records", "auto_annotation_tasks"):
        with op.batch_alter_table(table, recreate=_recreate()) as batch:
            batch.alter_column("model_id", existing_type=sa.String(64), type_=sa.String(128), nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("model_versions", recreate=_recreate()) as batch:
        batch.alter_column("id", existing_type=sa.String(128), type_=sa.String(64), nullable=False)
        batch.alter_column("source_model_id", existing_type=sa.String(128), type_=sa.String(64))
    for table in ("model_test_records", "model_evaluation_records", "auto_annotation_tasks"):
        with op.batch_alter_table(table, recreate=_recreate()) as batch:
            batch.alter_column("model_id", existing_type=sa.String(128), type_=sa.String(64), nullable=False)
