"""Model versions: converting/failed status for in-place OM conversion rows.

Revision ID: 0030_model_converting_status
Revises: 0029_model_om_format
Create Date: 2026-10-26
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0030_model_converting_status"
down_revision: str | None = "0029_model_om_format"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STATUSES = "'active', 'archived', 'converting', 'failed'"
_PREV_STATUSES = "'active', 'archived'"


def upgrade() -> None:
    with op.batch_alter_table("model_versions", recreate="always") as batch:
        batch.drop_constraint("ck_model_version_status", type_="check")
        batch.create_check_constraint("ck_model_version_status", f"status IN ({_STATUSES})")


def downgrade() -> None:
    with op.batch_alter_table("model_versions", recreate="always") as batch:
        batch.drop_constraint("ck_model_version_status", type_="check")
        batch.create_check_constraint("ck_model_version_status", f"status IN ({_PREV_STATUSES})")
