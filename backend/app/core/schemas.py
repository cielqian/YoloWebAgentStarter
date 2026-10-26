from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.task_types import TaskType

SplitName = Literal["train", "val", "test"]
AnnotationType = Literal["bbox", "polygon", "obb", "classify", "pose"]
AnnotationSource = Literal["manual", "imported", "sam", "auto"]


class PoseConfig(BaseModel):
    """pose 数据集的骨架配置：决定标注、导出与训练 data.yaml 的 kpt_shape。"""

    kpt_count: int = Field(ge=1, le=133)
    kpt_dim: int = Field(default=3, ge=2, le=3)
    kpt_names: list[str | None] | None = Field(default=None, max_length=133)
    skeleton: list[tuple[int, int]] | None = Field(default=None, max_length=500)

    @field_validator("kpt_names")
    @classmethod
    def kpt_names_length(cls, value: list[str | None] | None) -> list[str | None] | None:
        if value is not None and any(name is not None and (not name.strip() or len(name) > 64) for name in value):
            raise ValueError("keypoint names must be non-blank and at most 64 characters")
        return value

    @model_validator(mode="after")
    def names_match_count(self) -> "PoseConfig":
        if self.kpt_names is not None and len(self.kpt_names) != self.kpt_count:
            raise ValueError("kpt_names length must match kpt_count")
        if self.skeleton is not None and any(
            not (0 <= a < self.kpt_count) or not (0 <= b < self.kpt_count) or a == b for a, b in self.skeleton
        ):
            raise ValueError("skeleton edges must reference distinct keypoint indexes within range")
        return self


class ORMModel(BaseModel):
    # populate_by_name 允许带 validation_alias 的字段（如 pose_config ← pose_config_json）
    # 仍可按字段名构造，from_attributes 的 ORM 读取不受影响。
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class DatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    model_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    task_type: TaskType
    pose_config: PoseConfig | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def pose_requires_config(self) -> "DatasetCreate":
        # 导入路径允许不带 pose_config（从压缩包的 kpt_shape/标签行推断），
        # 空白数据集创建在 service 层强制要求显式配置。
        if self.task_type is not TaskType.POSE:
            self.pose_config = None
        return self


class DatasetFtpMergeCreate(BaseModel):
    """从 FTP 上的 ZIP 或 YOLO 目录合并进已有数据集（异步）。"""

    path: str = Field(min_length=1, max_length=1024)
    source: Literal["zip", "dir"] = "zip"

    @field_validator("path")
    @classmethod
    def strip_path(cls, value: str) -> str:
        return value.strip()


class DatasetMergeStarted(BaseModel):
    """异步合并已启动；进度与结果见 dataset.import_state。"""

    dataset: "DatasetResponse"


class DatasetMergeResult(BaseModel):
    """Yolo 压缩包合并进已有数据集的结果。"""

    dataset: "DatasetResponse"
    imported_images: int
    imported_annotations: int
    created_classes: int
    skipped_images: int
    split_counts: dict[str, int] = Field(default_factory=dict)


class DatasetImportStarted(BaseModel):
    """wait=false 的异步导入：占位数据集已创建，进度见 dataset.import_state。"""

    dataset: "DatasetResponse"


class DatasetFtpImportCreate(BaseModel):
    """从 FTP 上的 ZIP 压缩包或 YOLO 目录导入数据集。"""

    path: str = Field(min_length=1, max_length=1024)
    name: str = Field(min_length=1, max_length=255)
    model_name: str | None = Field(default=None, max_length=255)
    task_type: TaskType
    format: Literal["yolo", "coco"]
    source: Literal["zip", "dir"] = "zip"
    description: str | None = Field(default=None, max_length=2000)
    default_split: SplitName = "train"

    @field_validator("path", "name")
    @classmethod
    def strip_ftp_fields(cls, value: str) -> str:
        return value.strip()


class DatasetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    model_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def strip_optional_name(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class DatasetResponse(ORMModel):
    id: str
    name: str
    model_name: str | None = None
    description: str | None
    task_type: TaskType
    # ORM 列名为 pose_config_json，API 对外统一暴露为 pose_config。
    pose_config: PoseConfig | None = Field(default=None, validation_alias="pose_config_json")
    image_count: int
    annotated_image_count: int
    class_count: int
    latest_version_number: int | None = None
    active_version_number: int | None = None
    import_state: str | None = None
    import_progress: float = 0.0
    import_message: str | None = None
    created_at: datetime
    updated_at: datetime


class DatasetVersionCreate(BaseModel):
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("note")
    @classmethod
    def strip_note(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class DatasetVersionResponse(ORMModel):
    id: str
    dataset_id: str
    version_number: int
    note: str | None
    is_active: bool
    image_count: int
    annotation_count: int
    class_count: int
    has_pending_changes: bool | None = None
    created_at: datetime
    updated_at: datetime


class DatasetVersionActivateResponse(BaseModel):
    version: DatasetVersionResponse
    restored_images: int
    skipped_images: int


class DatasetVersionCloneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    version_id: str | None = None

    @field_validator("name", "description")
    @classmethod
    def strip_fields(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class DatasetVersionCloneResponse(BaseModel):
    dataset: DatasetResponse
    imported_images: int
    imported_annotations: int
    skipped_images: int


class ClassLabelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(default="#22c55e", pattern=r"^#[0-9a-fA-F]{6}$")
    sam3_prompt: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("class name cannot be blank")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("class name cannot contain path separators")
        return cleaned


class ClassLabelResponse(ORMModel):
    id: str
    dataset_id: str
    class_index: int
    name: str
    color: str
    sam3_prompt: str | None = None
    created_at: datetime
    updated_at: datetime


class ScanImagesRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    recursive: bool = True
    split: SplitName = "train"


class ScanImagesResponse(BaseModel):
    total_found: int
    imported: int
    skipped: int
    invalid: int


class ImageSplitUpdate(BaseModel):
    split: SplitName


class BulkImageSplitUpdate(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=10000)
    split: SplitName


class AutoSplitRequest(BaseModel):
    train_ratio: float = Field(default=0.8, ge=0, le=1)
    val_ratio: float = Field(default=0.1, ge=0, le=1)
    test_ratio: float = Field(default=0.1, ge=0, le=1)
    seed: int = Field(default=42, ge=0)

    @model_validator(mode="after")
    def ratios_sum_to_one(self) -> "AutoSplitRequest":
        if not math.isclose(self.train_ratio + self.val_ratio + self.test_ratio, 1.0, abs_tol=1e-3):
            raise ValueError("train_ratio, val_ratio and test_ratio must be non-negative and sum to 1")
        return self


class SplitOperationResponse(BaseModel):
    updated: int
    split_counts: dict[SplitName, int]


class DuplicateReport(BaseModel):
    images: int
    duplicate: int
    similar: int
    invalid_images: int
    invalid_image_ids: list[str]
    phash_distance: int
    groups: list[dict]


class TileDatasetRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    tile_size: int = Field(default=1024, ge=128, le=4096)
    overlap: float = Field(default=0.2, ge=0, lt=0.9)
    keep_empty_tiles: bool = False

    @field_validator("name")
    @classmethod
    def strip_tile_name(cls, value: str) -> str:
        return value.strip()


class TileDatasetResponse(BaseModel):
    dataset_id: str
    source_dataset_id: str
    generated_images: int
    generated_annotations: int
    skipped_empty_tiles: int


class ImageItemResponse(ORMModel):
    id: str
    dataset_id: str
    file_name: str
    width: int
    height: int
    split: SplitName
    status: str
    source_type: str
    source_file: str | None
    source_group_id: str | None
    source_video_task_id: str | None
    source_checksum: str | None
    frame_index: int | None
    timestamp: float | None
    file_url: str
    created_at: datetime
    updated_at: datetime


class ImagePage(BaseModel):
    items: list[ImageItemResponse]
    total: int


class UploadImagesResponse(BaseModel):
    imported: int
    items: list[ImageItemResponse]


class SourceImportRequest(BaseModel):
    source_dataset_id: str
    image_ids: list[str] | None = None
    tag_ids: list[str] | None = None
    tag_match: Literal["all", "any"] = "all"
    tag_values: dict[str, str] | None = None
    split: SplitName = "train"


class SourceImportResponse(BaseModel):
    imported: int
    skipped: int


class BBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class OBB(BaseModel):
    """An oriented bounding box stored in absolute image pixels."""

    cx: float
    cy: float
    width: float
    height: float
    angle: float


class AnnotationInput(BaseModel):
    type: AnnotationType
    class_id: str
    bbox: BBox | None = None
    polygon: list[tuple[float, float]] | None = None
    obb: OBB | None = None
    # pose 关键点 [x, y, v]，绝对像素；长度与可见性在服务层按数据集 kpt_count/kpt_dim 校验。
    keypoints: list[tuple[float, float, int]] | None = None
    source: AnnotationSource = "manual"

    @model_validator(mode="after")
    def shape_matches_type(self) -> "AnnotationInput":
        if self.type == "bbox" and self.bbox is None:
            raise ValueError("bbox is required for bbox annotations")
        if self.type == "polygon" and self.polygon is None:
            raise ValueError("polygon is required for polygon annotations")
        if self.type == "obb" and self.obb is None:
            raise ValueError("obb is required for oriented bounding-box annotations")
        if self.type == "pose" and (self.bbox is None or self.keypoints is None):
            raise ValueError("bbox and keypoints are required for pose annotations")
        return self

    @field_validator("polygon")
    @classmethod
    def finite_polygon(cls, value: list[tuple[float, float]] | None) -> list[tuple[float, float]] | None:
        if value is not None and not all(math.isfinite(x) and math.isfinite(y) for x, y in value):
            raise ValueError("polygon coordinates must be finite")
        return value

    @field_validator("keypoints")
    @classmethod
    def finite_keypoints(cls, value: list[tuple[float, float, int]] | None) -> list[tuple[float, float, int]] | None:
        if value is not None:
            for keypoint in value:
                if len(keypoint) != 3 or not math.isfinite(keypoint[0]) or not math.isfinite(keypoint[1]):
                    raise ValueError("keypoints must be [x, y, visibility] triples with finite coordinates")
                if keypoint[2] not in (0, 1, 2):
                    raise ValueError("keypoint visibility must be 0 (unlabeled), 1 (occluded), or 2 (visible)")
        return value


class ReplaceAnnotationsRequest(BaseModel):
    annotations: list[AnnotationInput] = Field(max_length=10000)


class AnnotationResponse(BaseModel):
    id: str
    image_id: str
    dataset_id: str
    class_id: str
    class_index: int
    label: str
    color: str
    type: AnnotationType
    bbox: BBox | None = None
    polygon: list[tuple[float, float]] | None = None
    obb: OBB | None = None
    keypoints: list[tuple[float, float, int]] | None = None
    source: AnnotationSource
    created_at: datetime
    updated_at: datetime


class ValidationIssue(BaseModel):
    level: Literal["error", "warning"]
    code: str
    message: str
    image_id: str | None = None
    annotation_id: str | None = None


class ValidationReport(BaseModel):
    dataset_id: str
    valid: bool
    error_count: int
    warning_count: int
    issues: list[ValidationIssue]


class YoloImportResponse(BaseModel):
    dataset: DatasetResponse
    imported_images: int
    imported_annotations: int


class DatasetDetailResponse(DatasetResponse):
    classes: list[ClassLabelResponse]
    image_total: int


class YoloExportInfo(BaseModel):
    dataset_id: str
    file_name: str
