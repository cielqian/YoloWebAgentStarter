"""Add pose task family: keypoints on annotations and per-dataset skeleton config.

Revision ID: 0026_pose_tasks
Revises: 0025_training_dispatching_status
Create Date: 2026-10-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_pose_tasks"
down_revision: str | None = "0025_training_dispatching_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TASKS = "'detect', 'segment', 'obb', 'classify', 'pose'"
_PREV_TASKS = "'detect', 'segment', 'obb', 'classify'"


def _replace_task_constraint(table: str, constraint: str, values: str) -> None:
    with op.batch_alter_table(table, recreate="always") as batch:
        batch.drop_constraint(constraint, type_="check")
        batch.create_check_constraint(constraint, f"task_type IN ({values})")


def upgrade() -> None:
    _replace_task_constraint("datasets", "ck_dataset_task_type", _TASKS)
    _replace_task_constraint("video_import_tasks", "ck_video_import_task_type", _TASKS)
    _replace_task_constraint("training_profiles", "ck_training_profile_task_type", _TASKS)
    _replace_task_constraint("training_tasks", "ck_training_task_type", _TASKS)
    _replace_task_constraint("model_versions", "ck_model_version_task_type", _TASKS)
    _replace_task_constraint("auto_annotation_tasks", "ck_auto_annotation_task_type", _TASKS)
    with op.batch_alter_table("datasets") as batch:
        batch.add_column(sa.Column("pose_config_json", sa.JSON(), nullable=True))
    with op.batch_alter_table("annotations", recreate="always") as batch:
        batch.add_column(sa.Column("keypoints", sa.JSON(), nullable=True))
        batch.drop_constraint("ck_annotation_type", type_="check")
        batch.create_check_constraint("ck_annotation_type", "type IN ('bbox', 'polygon', 'obb', 'classify', 'pose')")


def downgrade() -> None:
    with op.batch_alter_table("annotations", recreate="always") as batch:
        batch.drop_constraint("ck_annotation_type", type_="check")
        batch.drop_column("keypoints")
        batch.create_check_constraint("ck_annotation_type", f"type IN ({_PREV_TASKS})")
    with op.batch_alter_table("datasets") as batch:
        batch.drop_column("pose_config_json")
    _replace_task_constraint("auto_annotation_tasks", "ck_auto_annotation_task_type", _PREV_TASKS)
    _replace_task_constraint("model_versions", "ck_model_version_task_type", _PREV_TASKS)
    _replace_task_constraint("training_tasks", "ck_training_task_type", _PREV_TASKS)
    _replace_task_constraint("training_profiles", "ck_training_profile_task_type", _PREV_TASKS)
    _replace_task_constraint("video_import_tasks", "ck_video_import_task_type", _PREV_TASKS)
    _replace_task_constraint("datasets", "ck_dataset_task_type", _PREV_TASKS)
