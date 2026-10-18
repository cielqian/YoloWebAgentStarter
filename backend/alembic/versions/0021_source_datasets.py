"""Source datasets: raw image pools with FTP sync, uploads, and multi-value image tags."""

import sqlalchemy as sa
from alembic import op

revision = "0021_source_datasets"
down_revision = "0020_class_templates_sam3_prompt"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "source_datasets",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tag_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "source_images",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_dataset_id", sa.String(64), sa.ForeignKey("source_datasets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("file_name", sa.String(512), nullable=False),
        sa.Column("storage_name", sa.String(512), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_type", sa.String(16), nullable=False, server_default="upload"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("source_dataset_id", "storage_name", name="uq_source_image_dataset_storage"),
        sa.CheckConstraint("source_type IN ('upload', 'ftp')", name="ck_source_image_type"),
    )
    op.create_index("ix_source_images_source_dataset_id", "source_images", ["source_dataset_id"])
    op.create_table(
        "source_tags",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_dataset_id", sa.String(64), sa.ForeignKey("source_datasets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("color", sa.String(16), nullable=False, server_default="#3157d5"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("source_dataset_id", "name", name="uq_source_tag_dataset_name"),
    )
    op.create_index("ix_source_tags_source_dataset_id", "source_tags", ["source_dataset_id"])
    op.create_table(
        "source_image_tags",
        sa.Column("image_id", sa.String(64), sa.ForeignKey("source_images.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.String(64), sa.ForeignKey("source_tags.id", ondelete="CASCADE"), primary_key=True),
    )


def downgrade() -> None:
    op.drop_table("source_image_tags")
    op.drop_index("ix_source_tags_source_dataset_id", table_name="source_tags")
    op.drop_table("source_tags")
    op.drop_index("ix_source_images_source_dataset_id", table_name="source_images")
    op.drop_table("source_images")
    op.drop_table("source_datasets")
