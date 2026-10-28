"""Dataset versions: user-editable text label (default v{n}).

Revision ID: 0036_dataset_version_label
Revises: 0035_model_version_id_length
Create Date: 2026-10-28

version_number 保留为内部自增序号(排序/唯一性/训练任务引用);
version_label 是展示用文本,默认回填 v{version_number},数据集内唯一。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036_dataset_version_label"
down_revision: str | None = "0035_model_version_id_length"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _recreate() -> str:
    # SQLite 加唯一约束必须整表重建;PG 直接 ADD CONSTRAINT。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    with op.batch_alter_table("dataset_versions", recreate=_recreate()) as batch:
        batch.add_column(sa.Column("version_label", sa.String(length=64), nullable=False, server_default=""))
    op.execute("UPDATE dataset_versions SET version_label = 'v' || version_number WHERE version_label = ''")
    with op.batch_alter_table("dataset_versions", recreate=_recreate()) as batch:
        batch.create_unique_constraint("uq_dataset_version_label", ["dataset_id", "version_label"])


def downgrade() -> None:
    with op.batch_alter_table("dataset_versions", recreate=_recreate()) as batch:
        batch.drop_constraint("uq_dataset_version_label", type_="unique")
        batch.drop_column("version_label")
