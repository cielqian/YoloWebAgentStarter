from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.schemas import BBox, OBB

# 算法测试模块不支持 OCR 与 pose:任务类型限定四类。
TestTaskType = Literal["detect", "segment", "obb", "classify"]
# 用途标签:回归基线 / 扩充集 / 难例集 / 验收集
TestPurposeTag = Literal["regression", "augment", "hard", "acceptance"]
TestImageStatus = Literal["unmarked", "marked"]
TestAnnotationType = Literal["bbox", "polygon", "obb", "classify"]

TEST_PURPOSE_LABELS: dict[str, str] = {
    "regression": "回归基线",
    "augment": "扩充集",
    "hard": "难例集",
    "acceptance": "验收集",
}


class TestDatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    task_type: TestTaskType
    purpose_tag: TestPurposeTag | None = None
    ftp_dir: str | None = Field(default=None, max_length=1024)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("name cannot be blank")
        return cleaned

    @field_validator("ftp_dir")
    @classmethod
    def normalize_ftp_dir(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            return None
        if not cleaned.startswith("/"):
            raise ValueError("ftp_dir must be an absolute FTP path starting with /")
        return cleaned.rstrip("/") or "/"


class TestDatasetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    version: str | None = Field(default=None, min_length=1, max_length=64)
    purpose_tag: TestPurposeTag | None = None
    ftp_dir: str | None = Field(default=None, max_length=1024)
    notes: str | None = Field(default=None, max_length=4000)


class TestDatasetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    task_type: TestTaskType
    source: Literal["local", "ftp"]
    version: str
    purpose_tag: TestPurposeTag | None
    status: Literal["ready", "annotating", "locked"]
    ftp_dir: str | None
    notes: str | None
    image_count: int
    class_count: int
    marked_count: int
    marked_percent: float = 0.0
    # FTP 异步建集:None=正常,importing/completed/failed/stopped
    import_state: str | None = None
    import_progress: float = 0.0
    import_message: str | None = None
    created_at: datetime
    updated_at: datetime


class TestClassCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(default="#22c55e", pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("class name cannot be blank")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("class name cannot contain path separators")
        return cleaned


class TestClassResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    test_dataset_id: str
    class_index: int
    name: str
    color: str
    created_at: datetime
    updated_at: datetime


class TestClassImportRequest(BaseModel):
    template_ids: list[str] = Field(min_length=1, max_length=200)


class TestClassImportResponse(BaseModel):
    imported: list[TestClassResponse]
    skipped_names: list[str]


class TestImageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    test_dataset_id: str
    file_name: str
    width: int
    height: int
    status: TestImageStatus
    point_id: str | None
    ftp_path: str | None
    created_at: datetime


class TestImagePage(BaseModel):
    items: list[TestImageResponse]
    total: int
    offset: int
    limit: int


class TestImageUpdate(BaseModel):
    point_id: str | None = Field(default=None, max_length=255)


class TestUploadResponse(BaseModel):
    imported: int
    duplicates: list[str]
    items: list[TestImageResponse]


class TestFtpImportCreate(BaseModel):
    """从 FTP 目录/压缩包异步建测试数据集。"""

    name: str = Field(min_length=1, max_length=255)
    task_type: TestTaskType
    purpose_tag: TestPurposeTag | None = None
    ftp_dir: str | None = Field(default=None, max_length=1024)
    notes: str | None = Field(default=None, max_length=4000)
    path: str = Field(min_length=1, max_length=2048)
    source: Literal["zip", "dir"] = "zip"

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("name cannot be blank")
        return cleaned


class TestImageNeighborsResponse(BaseModel):
    previous: TestImageResponse | None
    next: TestImageResponse | None
    index: int
    total: int


class TestAnnotationInput(BaseModel):
    type: TestAnnotationType
    class_id: str
    bbox: BBox | None = None
    polygon: list[tuple[float, float]] | None = None
    obb: OBB | None = None
    difficult: bool = False

    @model_validator(mode="after")
    def shape_matches_type(self) -> "TestAnnotationInput":
        if self.type == "bbox" and self.bbox is None:
            raise ValueError("bbox is required for bbox annotations")
        if self.type == "polygon" and self.polygon is None:
            raise ValueError("polygon is required for polygon annotations")
        if self.type == "obb" and self.obb is None:
            raise ValueError("obb is required for oriented bounding-box annotations")
        return self


class ReplaceTestAnnotationsRequest(BaseModel):
    annotations: list[TestAnnotationInput] = Field(max_length=10000)


class TestAnnotationResponse(BaseModel):
    id: str
    image_id: str
    test_dataset_id: str
    class_id: str
    class_index: int
    label: str
    color: str
    type: TestAnnotationType
    bbox: BBox | None = None
    polygon: list[tuple[float, float]] | None = None
    obb: OBB | None = None
    difficult: bool
    source: str
    created_at: datetime
    updated_at: datetime
