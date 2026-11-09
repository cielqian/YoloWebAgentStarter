"""Tag template material types association.

Revision ID: 0039_tag_material_types
Revises: 0038_training_params
Create Date: 2026-11-09

标签库关联素材类型:tag_templates 增加 material_types(JSON 名称数组),一个标签可关联多个素材类型;
历史标签统一回填关联到「叶片」。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039_tag_material_types"
down_revision: str | None = "0038_training_params"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _recreate() -> str:
    # SQLite 加列约束走整表重建;PG 直接 DDL。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def upgrade() -> None:
    with op.batch_alter_table("tag_templates", recreate=_recreate()) as batch:
        batch.add_column(sa.Column("material_types", sa.JSON(), nullable=True))
    # 历史标签统一关联到「叶片」素材类型
    op.execute("UPDATE tag_templates SET material_types = '[\"叶片\"]' WHERE material_types IS NULL")


def downgrade() -> None:
    with op.batch_alter_table("tag_templates", recreate=_recreate()) as batch:
        batch.drop_column("material_types")
