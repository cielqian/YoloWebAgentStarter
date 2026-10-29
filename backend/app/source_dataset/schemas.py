from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SourceDatasetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    material_types: list[str] | None = Field(default=None, max_length=32)


class SourceDatasetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    material_types: list[str] | None = Field(default=None, max_length=32)


class SourceDatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str | None
    image_count: int
    tag_count: int
    material_types: list[str] | None = None
    created_at: datetime
    updated_at: datetime


class SourceTagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(default="#3157d5", max_length=16)
    values: list[str] | None = Field(default=None, max_length=32)


class SourceTagUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    color: str | None = Field(default=None, max_length=16)
    values: list[str] | None = Field(default=None, max_length=32)


class SourceTagOut(BaseModel):
    id: str
    name: str
    color: str
    values: list[str] | None = None
    # 图片上的枚举取值(仅图片标签列表出现)
    value: str | None = None
    image_count: int


class SourceImageUpdate(BaseModel):
    file_name: str | None = Field(default=None, min_length=1, max_length=512)
    tag_ids: list[str] | None = None
    tag_values: dict[str, str] | None = None


class SourceImageOut(BaseModel):
    id: str
    file_name: str
    width: int
    height: int
    size_bytes: int
    source_type: str
    tags: list[SourceTagOut]
    file_url: str
    thumbnail_url: str
    created_at: datetime


class SourceImagePage(BaseModel):
    total: int
    offset: int
    limit: int
    items: list[SourceImageOut]


class SourceUploadResult(BaseModel):
    imported: int
    invalid: int


class SourceBatchTagsRequest(BaseModel):
    image_ids: list[str] = Field(min_length=1)
    tag_ids: list[str] = Field(min_length=1)
    remove: bool = False
    tag_values: dict[str, str] | None = None


class SourceBatchTagsResult(BaseModel):
    updated: int


class SourceFtpSyncRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    recursive: bool = True
    file_paths: list[str] | None = None
    tag_ids: list[str] | None = None
    tag_values: dict[str, str] | None = None


class SourceFtpSyncResult(BaseModel):
    synced: int
    skipped: int
    truncated: bool = False
