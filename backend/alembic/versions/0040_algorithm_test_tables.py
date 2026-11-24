"""Algorithm test module tables (test datasets + services + tasks + records).

Revision ID: 0040_algorithm_test_tables
Revises: 0039_tag_material_types
Create Date: 2026-11-24

算法测试模块(端到端算法服务指标测试)建表,完整设计见 docs/算法测试模块设计.md:
- test_datasets / test_class_labels / test_images / test_annotations: 测试数据集与预期结果标注
- algorithm_services: 算法服务(调用与解析 + 节点部署配置)
- algorithm_test_tasks / algorithm_test_records / algorithm_test_image_results /
  algorithm_test_review_marks: 测试任务、记录、每图结果与 TP/FP 人工复核
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040_algorithm_test_tables"
down_revision: str | None = "0039_tag_material_types"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "test_datasets",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("task_type", sa.String(length=16), nullable=False, index=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("purpose_tag", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("ftp_dir", sa.String(length=1024), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=False),
        sa.Column("class_count", sa.Integer(), nullable=False),
        sa.Column("marked_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("task_type IN ('detect', 'segment', 'obb', 'classify')", name="ck_test_dataset_task_type"),
        sa.CheckConstraint("source IN ('local', 'ftp')", name="ck_test_dataset_source"),
        sa.CheckConstraint("status IN ('ready', 'annotating', 'locked')", name="ck_test_dataset_status"),
    )
    op.create_table(
        "test_class_labels",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("test_dataset_id", sa.String(length=64), sa.ForeignKey("test_datasets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("class_index", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("test_dataset_id", "class_index", name="uq_test_class_label_dataset_index"),
        sa.UniqueConstraint("test_dataset_id", "name", name="uq_test_class_label_dataset_name"),
    )
    op.create_table(
        "test_images",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("test_dataset_id", sa.String(length=64), sa.ForeignKey("test_datasets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("file_name", sa.String(length=512), nullable=False),
        sa.Column("storage_name", sa.String(length=512), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, index=True),
        sa.Column("source_checksum", sa.String(length=64), nullable=True),
        sa.Column("point_id", sa.String(length=255), nullable=True),
        sa.Column("ftp_path", sa.String(length=1024), nullable=True),
        sa.Column("ftp_uploaded_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("test_dataset_id", "storage_name", name="uq_test_image_dataset_storage"),
        sa.CheckConstraint("status IN ('unmarked', 'marked')", name="ck_test_image_status"),
    )
    op.create_table(
        "test_annotations",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("test_image_id", sa.String(length=64), sa.ForeignKey("test_images.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("test_dataset_id", sa.String(length=64), sa.ForeignKey("test_datasets.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("test_class_id", sa.String(length=64), sa.ForeignKey("test_class_labels.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("type", sa.String(length=16), nullable=False),
        sa.Column("x", sa.Float(), nullable=True),
        sa.Column("y", sa.Float(), nullable=True),
        sa.Column("width", sa.Float(), nullable=True),
        sa.Column("height", sa.Float(), nullable=True),
        sa.Column("polygon", sa.JSON(), nullable=True),
        sa.Column("obb", sa.JSON(), nullable=True),
        sa.Column("difficult", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("type IN ('bbox', 'polygon', 'obb', 'classify')", name="ck_test_annotation_type"),
    )
    op.create_table(
        "algorithm_services",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False, unique=True),
        sa.Column("model_id", sa.String(length=128), sa.ForeignKey("model_versions.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("node_id", sa.String(length=64), nullable=False, index=True),
        sa.Column("host", sa.String(length=255), nullable=True),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, index=True),
        sa.Column("request_config", sa.JSON(), nullable=False),
        sa.Column("parse_config", sa.JSON(), nullable=False),
        sa.Column("deploy_config", sa.JSON(), nullable=False),
        sa.Column("container_id", sa.String(length=128), nullable=True),
        sa.Column("last_health_at", sa.DateTime(), nullable=True),
        sa.Column("last_health_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "status IN ('creating', 'starting', 'running', 'stopped', 'failed', 'deleting')",
            name="ck_algorithm_service_status",
        ),
    )
    op.create_table(
        "algorithm_test_tasks",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("service_id", sa.String(length=64), sa.ForeignKey("algorithm_services.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("test_dataset_id", sa.String(length=64), sa.ForeignKey("test_datasets.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("status", sa.String(length=16), nullable=False, index=True),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "status IN ('queued', 'preparing', 'running', 'computing', 'completed', 'failed', 'canceled')",
            name="ck_algorithm_test_task_status",
        ),
    )
    op.create_table(
        "algorithm_test_records",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("task_id", sa.String(length=64), sa.ForeignKey("algorithm_test_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("service_id", sa.String(length=64), nullable=False, index=True),
        sa.Column("model_id", sa.String(length=128), nullable=False, index=True),
        sa.Column("model_name", sa.String(length=255), nullable=False),
        sa.Column("model_version", sa.String(length=64), nullable=False),
        sa.Column("test_dataset_id", sa.String(length=64), nullable=False, index=True),
        sa.Column("test_dataset_name", sa.String(length=255), nullable=False),
        sa.Column("test_dataset_version", sa.String(length=64), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("metrics_auto", sa.JSON(), nullable=False),
        sa.Column("metrics_reviewed", sa.JSON(), nullable=True),
        sa.Column("latency_stats", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "algorithm_test_image_results",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("record_id", sa.String(length=64), sa.ForeignKey("algorithm_test_records.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("test_image_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("predictions", sa.JSON(), nullable=False),
        sa.Column("matches", sa.JSON(), nullable=False),
        sa.Column("reviewed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("status IN ('ok', 'call_failed', 'parse_failed', 'skipped')", name="ck_algorithm_test_image_result_status"),
    )
    op.create_index("ix_algo_test_image_results_record", "algorithm_test_image_results", ["record_id", "test_image_id"])
    op.create_table(
        "algorithm_test_review_marks",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("record_id", sa.String(length=64), sa.ForeignKey("algorithm_test_records.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("image_result_id", sa.String(length=64), sa.ForeignKey("algorithm_test_image_results.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("target", sa.String(length=16), nullable=False),
        sa.Column("target_index", sa.Integer(), nullable=False),
        sa.Column("mark", sa.String(length=16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("target IN ('prediction', 'match')", name="ck_algorithm_test_review_target"),
        sa.CheckConstraint("mark IN ('confirm_tp', 'confirm_fp', 'ignore', 'missed_confirm')", name="ck_algorithm_test_review_mark"),
    )


def downgrade() -> None:
    op.drop_table("algorithm_test_review_marks")
    op.drop_index("ix_algo_test_image_results_record", table_name="algorithm_test_image_results")
    op.drop_table("algorithm_test_image_results")
    op.drop_table("algorithm_test_records")
    op.drop_table("algorithm_test_tasks")
    op.drop_table("algorithm_services")
    op.drop_table("test_annotations")
    op.drop_table("test_images")
    op.drop_table("test_class_labels")
    op.drop_table("test_datasets")
