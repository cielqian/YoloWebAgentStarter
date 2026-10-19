from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_session, get_settings, get_training_service
from app.core.config import Settings
from app.settings.schemas import TrainingNodeCreate, TrainingNodeOut, TrainingNodeTestRequest, TrainingNodeTestResult
from app.settings.service import SettingsService
from app.training.runtime.remote_nodes import merged_devices, probe_node
from app.training.schemas import (
    TrainingLogResponse,
    TrainingNodeStatus,
    TrainingProfileCreate,
    TrainingProfileResponse,
    TrainingProfileUpdate,
    TrainingSummaryResponse,
    TrainingTaskCreate,
    TrainingTaskList,
    TrainingTaskResponse,
    TrainingTaskResumeRequest,
    TrainingDeviceListResponse,
)
from app.training.service import TrainingService


router = APIRouter(prefix="/training", tags=["training"])


@router.get("/devices", response_model=TrainingDeviceListResponse)
def list_devices(
    service: TrainingService = Depends(get_training_service),
    settings: Settings = Depends(get_settings),
) -> TrainingDeviceListResponse:
    items, nodes = merged_devices(settings)
    return TrainingDeviceListResponse(items=items, nodes=[TrainingNodeStatus(**node) for node in nodes])


@router.get("/nodes", response_model=list[TrainingNodeOut])
def list_training_nodes(settings: Settings = Depends(get_settings)) -> list[TrainingNodeOut]:
    return [TrainingNodeOut(**item) for item in SettingsService(settings).list_training_nodes_out()]


@router.post("/nodes", response_model=TrainingNodeOut, status_code=201)
def create_training_node(payload: TrainingNodeCreate, settings: Settings = Depends(get_settings)) -> TrainingNodeOut:
    return TrainingNodeOut(**SettingsService(settings).add_training_node(payload))


@router.post("/nodes/test", response_model=TrainingNodeTestResult)
def test_training_node(payload: TrainingNodeTestRequest, settings: Settings = Depends(get_settings)) -> TrainingNodeTestResult:
    if not payload.url.lower().startswith(("http://", "https://")):
        return TrainingNodeTestResult(ok=False, message="节点地址必须以 http:// 或 https:// 开头。")
    return TrainingNodeTestResult(**probe_node(payload.url, payload.token))


@router.delete("/nodes/{node_id}", status_code=204, response_class=Response, response_model=None)
def delete_training_node(node_id: str, settings: Settings = Depends(get_settings)) -> None:
    SettingsService(settings).delete_training_node(node_id)


@router.get("/profiles", response_model=list[TrainingProfileResponse])
def list_profiles(
    dataset_id: str | None = None,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> list[TrainingProfileResponse]:
    return service.list_profiles(session, dataset_id)


@router.post("/profiles", response_model=TrainingProfileResponse, status_code=201)
def create_profile(
    payload: TrainingProfileCreate,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingProfileResponse:
    return service.create_profile(session, payload)


@router.patch("/profiles/{profile_id}", response_model=TrainingProfileResponse)
def update_profile(
    profile_id: str,
    payload: TrainingProfileUpdate,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingProfileResponse:
    return service.update_profile(session, profile_id, payload)


@router.get("/tasks", response_model=TrainingTaskList)
def list_tasks(
    dataset_id: str | None = None,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingTaskList:
    return service.list_tasks(session, dataset_id)


@router.post("/tasks", response_model=TrainingTaskResponse, status_code=201)
def create_task(
    payload: TrainingTaskCreate,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
    settings: Settings = Depends(get_settings),
) -> TrainingTaskResponse:
    return service.create_task(session, payload, settings=settings)


@router.post("/tasks/{task_id}/resume", response_model=TrainingTaskResponse, status_code=201)
def resume_task(
    task_id: str,
    payload: TrainingTaskResumeRequest,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingTaskResponse:
    return service.resume_task(session, task_id, payload)


@router.get("/tasks/{task_id}", response_model=TrainingTaskResponse)
def get_task(
    task_id: str,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingTaskResponse:
    return service.get_task_response(session, task_id)


@router.post("/tasks/{task_id}/stop", response_model=TrainingTaskResponse)
def stop_task(
    task_id: str,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
    settings: Settings = Depends(get_settings),
) -> TrainingTaskResponse:
    return service.stop_task(session, task_id, settings=settings)


@router.get("/tasks/{task_id}/logs", response_model=TrainingLogResponse)
def get_logs(
    task_id: str,
    tail: int = Query(default=200, ge=1, le=10000),
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingLogResponse:
    return service.logs(session, task_id, tail)


@router.get("/tasks/{task_id}/summary", response_model=TrainingSummaryResponse)
def get_summary(
    task_id: str,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> TrainingSummaryResponse:
    return service.summary(session, task_id)


@router.get("/tasks/{task_id}/checkpoints/{checkpoint_name}")
def download_checkpoint(
    task_id: str,
    checkpoint_name: str,
    session: Session = Depends(get_session),
    service: TrainingService = Depends(get_training_service),
) -> FileResponse:
    path = service.checkpoint(session, task_id, checkpoint_name)
    return FileResponse(path, media_type="application/octet-stream", filename=f"{checkpoint_name}.pt")
