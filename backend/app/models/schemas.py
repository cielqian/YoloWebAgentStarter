from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.task_types import TaskType

ModelSource = Literal["training_task", "exported"]
ModelStatus = Literal["active", "archived"]
ModelArtifactType = Literal["best", "last", "onnx", "om"]
ModelFormat = Literal["pt", "onnx", "om"]


class ModelVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    version: str
    dataset_id: str | None
    training_task_id: str | None
    source_model_id: str | None
    source: ModelSource
    artifact_type: ModelArtifactType
    format: ModelFormat
    task_type: TaskType
    engine_type: str
    model_path: str
    base_model: str | None
    status: ModelStatus
    precision: float | None
    recall: float | None
    map50: float | None
    map50_95: float | None
    metrics_json: dict
    notes: str
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ModelVersionList(BaseModel):
    items: list[ModelVersionResponse]
    total: int


class ModelVersionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    version: str | None = Field(default=None, min_length=1, max_length=64)
    notes: str | None = Field(default=None, max_length=4000)


class InferenceDetection(BaseModel):
    class_index: int
    class_name: str
    confidence: float
    x: float
    y: float
    width: float
    height: float
    polygon: list[list[float]] | None = None
    obb_points: list[list[float]] | None = None


class InferenceResult(BaseModel):
    model_id: str
    task_type: TaskType
    detections: list[InferenceDetection]
    inference_time_ms: float


class ModelTestRecordResponse(BaseModel):
    id: str
    model_id: str
    file_name: str
    result_json: dict
    created_at: datetime


class ModelEvaluationRequest(BaseModel):
    split: Literal["train", "val", "test"] = "val"
    confidence: float = Field(default=0.25, ge=0, le=1)
    iou: float = Field(default=0.5, ge=0, le=1)


class ModelEvaluationRecordResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    model_id: str
    dataset_id: str
    split: Literal["train", "val", "test"]
    status: Literal["pending", "running", "completed", "failed"]
    confidence: float
    iou: float
    result_json: dict
    error_message: str | None
    export_path: str | None
    data_path: str | None
    run_dir: str | None
    logs_path: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class ModelEvaluationLogResponse(BaseModel):
    evaluation_id: str
    logs: str
    line_count: int


class ModelCompareRequest(BaseModel):
    baseline_model_id: str
    candidate_model_id: str


class ModelCompareResponse(BaseModel):
    dataset_id: str
    baseline: dict
    candidate: dict
    deltas: dict[str, float | None]
    suggestions: list[str]


class OmConvertRequest(BaseModel):
    node_id: str = Field(min_length=1)
    soc_version: str = Field(default="Ascend310P3", min_length=1, max_length=64)
    input_shape: str = Field(default="images:1,3,640,640", min_length=1, max_length=128)


class OmConvertJobResponse(BaseModel):
    job_id: str
    source_model_id: str
    source_model_name: str
    node_id: str
    node_name: str
    soc_version: str
    input_shape: str
    status: str
    error: str | None
    logs: str
    result_model_id: str | None
    created_at: datetime
    finished_at: datetime | None
