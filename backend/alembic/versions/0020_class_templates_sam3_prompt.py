"""Class template library and SAM3 prompt attribute on dataset classes."""

import sqlalchemy as sa
from alembic import op

revision = "0020_class_templates_sam3_prompt"
down_revision = "0019_agent_history_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "class_templates",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("color", sa.String(16), nullable=False, server_default="#22c55e"),
        sa.Column("sam3_prompt", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_class_template_name"),
    )
    op.add_column("class_labels", sa.Column("sam3_prompt", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("class_labels", "sam3_prompt")
    op.drop_table("class_templates")
