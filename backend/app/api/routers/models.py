from __future__ import annotations

import httpx

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_evaluation_runner, get_session, get_settings, get_storage
from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.storage import Storage
from app.models import om_convert
from app.models.schemas import InferenceResult, ModelCompareRequest, ModelCompareResponse, ModelEvaluationLogResponse, ModelEvaluationRecordResponse, ModelEvaluationRequest, ModelTestRecordResponse, ModelVersionList, ModelVersionResponse, ModelVersionUpdate, OmConvertJobResponse, OmConvertRequest
from app.models.evaluation import YoloEvaluationRunner
from app.models.service import ModelService
from app.settings.schemas import TrainingNodeCreate, TrainingNodeOut, TrainingNodeTestRequest, TrainingNodeTestResult
from app.settings.service import SettingsService
from app.training.runtime.remote_nodes import probe_node


router = APIRouter(prefix="/models", tags=["models"])
om_router = APIRouter(prefix="/om-convert", tags=["om-convert"])


@om_router.get("/nodes", response_model=list[TrainingNodeOut])
def list_om_nodes(settings: Settings = Depends(get_settings)) -> list[TrainingNodeOut]:
    return [TrainingNodeOut(**item) for item in SettingsService(settings).list_om_nodes_out()]


@om_router.post("/nodes", response_model=TrainingNodeOut, status_code=201)
def create_om_node(payload: TrainingNodeCreate, settings: Settings = Depends(get_settings)) -> TrainingNodeOut:
    return TrainingNodeOut(**SettingsService(settings).add_om_node(payload))


@om_router.post("/nodes/test", response_model=TrainingNodeTestResult)
def test_om_node(payload: TrainingNodeTestRequest, settings: Settings = Depends(get_settings)) -> TrainingNodeTestResult:
    if not payload.url.lower().startswith(("http://", "https://")):
        return TrainingNodeTestResult(ok=False, message="节点地址必须以 http:// 或 https:// 开头。")
    result = dict(probe_node(payload.url, payload.token))
    if not result.get("ok"):
        return TrainingNodeTestResult(**result)
    base = payload.url.strip().rstrip("/")
    headers = {"X-Agent-Token": payload.token.strip()} if payload.token.strip() else {}
    try:
        health = httpx.get(f"{base}/health", headers=headers, timeout=10.0)
        convert_supported = bool(health.status_code == 200 and health.json().get("convert_supported"))
    except (httpx.HTTPError, ValueError):
        convert_supported = False
    result["convert_supported"] = convert_supported
    result["message"] = f"{result.get('message') or '连接成功'} · {'ATC 可用' if convert_supported else '未检测到 atc（无法转换 OM）'}"
    return TrainingNodeTestResult(**result)


@om_router.delete("/nodes/{node_id}", status_code=204, response_class=Response, response_model=None)
def delete_om_node(node_id: str, settings: Settings = Depends(get_settings)) -> None:
    SettingsService(settings).delete_om_node(node_id)


@router.post("/compare", response_model=ModelCompareResponse)
def compare_models(payload: ModelCompareRequest, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> ModelCompareResponse:
    return ModelCompareResponse.model_validate(ModelService(storage).compare(session, payload.baseline_model_id, payload.candidate_model_id))


@router.post("/{model_id}/convert-om", response_model=OmConvertJobResponse, status_code=202)
def convert_model_to_om(
    model_id: str,
    payload: OmConvertRequest,
    request: Request,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> OmConvertJobResponse:
    ModelService(storage).get_model_response(session, model_id)
    job = om_convert.start_convert(
        request.app.state.database.session_factory,
        storage,
        settings,
        model_id,
        payload.node_id,
        payload.soc_version,
        payload.input_shape,
    )
    return OmConvertJobResponse.model_validate(job)


@router.get("", response_model=ModelVersionList)
def list_models(
    dataset_id: str | None = Query(default=None),
    include_archived: bool = Query(default=False),
    dataset_version: int | None = Query(default=None),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionList:
    return ModelService(storage).list_models(session, dataset_id, include_archived, dataset_version)


@router.get("/{model_id}", response_model=ModelVersionResponse)
def get_model(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionResponse:
    return ModelService(storage).get_model_response(session, model_id)


@router.patch("/{model_id}", response_model=ModelVersionResponse)
def update_model(
    model_id: str,
    payload: ModelVersionUpdate,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionResponse:
    return ModelService(storage).update_model(session, model_id, payload)


@router.post("/{model_id}/archive", response_model=ModelVersionResponse)
def archive_model(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionResponse:
    return ModelService(storage).archive_model(session, model_id)


@router.post("/{model_id}/restore", response_model=ModelVersionResponse)
def restore_model(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionResponse:
    return ModelService(storage).restore_model(session, model_id)


@router.delete("/{model_id}", status_code=204, response_class=Response, response_model=None)
def delete_model(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> None:
    ModelService(storage).delete_model(session, model_id)


@router.get("/{model_id}/download")
def download_model(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> FileResponse:
    path = ModelService(storage).download_path(session, model_id)
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@router.post("/{model_id}/export-onnx", response_model=ModelVersionResponse)
def export_onnx(
    model_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelVersionResponse:
    return ModelService(storage).export_onnx(session, model_id)


@router.post("/{model_id}/test", response_model=InferenceResult)
async def test_model(
    model_id: str,
    file: UploadFile = File(...),
    confidence: float = Query(default=0.25, ge=0, le=1),
    iou: float = Query(default=0.45, ge=0, le=1),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> InferenceResult:
    image_bytes = await file.read(settings.max_upload_bytes + 1)
    if len(image_bytes) > settings.max_upload_bytes:
        raise ValidationError("upload_too_large", f"Upload exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit.")
    service = ModelService(storage)
    result = service.run_test_inference(session, model_id, image_bytes, confidence, iou)
    service.save_test_record(session, model_id, file.filename or "test.jpg", image_bytes, result)
    return InferenceResult.model_validate(result)


@router.get("/{model_id}/tests", response_model=list[ModelTestRecordResponse])
def list_model_tests(model_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> list[ModelTestRecordResponse]:
    return [ModelTestRecordResponse.model_validate(item) for item in ModelService(storage).list_test_records(session, model_id)]


@router.post("/{model_id}/evaluate", response_model=ModelEvaluationRecordResponse, status_code=201)
def evaluate_model(model_id: str, payload: ModelEvaluationRequest, session: Session = Depends(get_session), storage: Storage = Depends(get_storage), runner: YoloEvaluationRunner = Depends(get_evaluation_runner)) -> ModelEvaluationRecordResponse:
    record = ModelService(storage).create_evaluation(session, model_id, payload.split, payload.confidence, payload.iou)
    runner.start_task(record.id)
    return ModelEvaluationRecordResponse.model_validate(record)


@router.get("/{model_id}/evaluations", response_model=list[ModelEvaluationRecordResponse])
def list_model_evaluations(model_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> list[ModelEvaluationRecordResponse]:
    return [ModelEvaluationRecordResponse.model_validate(item) for item in ModelService(storage).list_evaluations(session, model_id)]


@router.get("/{model_id}/evaluations/{evaluation_id}/logs", response_model=ModelEvaluationLogResponse)
def get_model_evaluation_logs(
    model_id: str,
    evaluation_id: str,
    tail: int | None = Query(default=None, ge=1, le=10000),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ModelEvaluationLogResponse:
    return ModelService(storage).evaluation_logs(session, model_id, evaluation_id, tail)


@router.get("/{model_id}/evaluations/{evaluation_id}/artifacts/{artifact}")
def get_model_evaluation_artifact(
    model_id: str,
    evaluation_id: str,
    artifact: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> FileResponse:
    path = ModelService(storage).evaluation_artifact_path(session, model_id, evaluation_id, artifact)
    return FileResponse(path)
