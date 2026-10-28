"""Model versions: Huawei Ascend OM artifact format via remote ATC conversion.

Revision ID: 0029_model_om_format
Revises: 0028_global_tag_library
Create Date: 2026-10-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0029_model_om_format"
down_revision: str | None = "0028_global_tag_library"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FORMATS = "'pt', 'onnx', 'om'"
_ARTIFACTS = "'best', 'last', 'onnx', 'om'"
_PREV_FORMATS = "'pt', 'onnx'"
_PREV_ARTIFACTS = "'best', 'last', 'onnx'"

def _recreate() -> str:
    # SQLite 删不了内联约束必须整表重建;PG 直接 ALTER,重建会被外部外键依赖挡住。
    return "always" if op.get_bind().dialect.name == "sqlite" else "auto"


def _replace(table: str, constraint: str, condition: str) -> None:
    with op.batch_alter_table(table, recreate=_recreate()) as batch:
        batch.drop_constraint(constraint, type_="check")
        batch.create_check_constraint(constraint, condition)


def upgrade() -> None:
    _replace("model_versions", "ck_model_version_format", f"format IN ({_FORMATS})")
    _replace("model_versions", "ck_model_version_artifact_type", f"artifact_type IN ({_ARTIFACTS})")


def downgrade() -> None:
    _replace("model_versions", "ck_model_version_artifact_type", f"artifact_type IN ({_PREV_ARTIFACTS})")
    _replace("model_versions", "ck_model_version_format", f"format IN ({_PREV_FORMATS})")
