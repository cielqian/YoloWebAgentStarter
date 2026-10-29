"""Material types library and source dataset material_types attribute.

Revision ID: 0037_material_types
Revises: 0036_dataset_version_label
Create Date: 2026-10-29

素材类型库(全局多选取值范围)+ 数据源素材类型多选属性(JSON 名称数组)。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0037_material_types"
down_revision: str | None = "0036_dataset_version_label"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _recreate() -> str:
    # SQLite 加列/建表约束走整表重建;PG 直接 DDL。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    op.create_table(
        "material_types",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_material_type_name"),
    )
    with op.batch_alter_table("source_datasets", recreate=_recreate()) as batch:
        batch.add_column(sa.Column("material_types", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("source_datasets", recreate=_recreate()) as batch:
        batch.drop_column("material_types")
    op.drop_table("material_types")
