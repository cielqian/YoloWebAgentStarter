"""Training tasks: add dispatching status for background data transfer."""

import sqlalchemy as sa
from alembic import op

revision = "0025_training_dispatching_status"
down_revision = "0024_dataset_import_progress"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.drop_constraint("ck_training_task_status", type_="check")
        batch.create_check_constraint(
            "ck_training_task_status",
            "status IN ('pending', 'dispatching', 'running', 'completed', 'failed', 'stopped')",
        )


def downgrade() -> None:
    with op.batch_alter_table("training_tasks") as batch:
        batch.drop_constraint("ck_training_task_status", type_="check")
        batch.create_check_constraint(
            "ck_training_task_status",
            "status IN ('pending', 'running', 'completed', 'failed', 'stopped')",
        )
