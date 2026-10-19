"""Remote training: dispatch training tasks to compute-agent nodes."""

import sqlalchemy as sa
from alembic import op

revision = "0023_remote_training"
down_revision = "0022_dataset_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("training_tasks", sa.Column("node_id", sa.String(length=64), nullable=True))
    op.create_index("ix_training_tasks_node_id", "training_tasks", ["node_id"])


def downgrade() -> None:
    op.drop_index("ix_training_tasks_node_id", table_name="training_tasks")
    op.drop_column("training_tasks", "node_id")
