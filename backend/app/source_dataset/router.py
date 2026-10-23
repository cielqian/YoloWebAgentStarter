from __future__ import annotations

import json
import queue
import threading

from pathlib import Path

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_session, get_settings, get_storage
from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.storage import Storage
from app.source_dataset import service
from app.source_dataset.schemas import (
    SourceBatchTagsRequest,
    SourceBatchTagsResult,
    SourceDatasetCreate,
    SourceDatasetOut,
    SourceDatasetUpdate,
    SourceFtpSyncRequest,
    SourceImageOut,
    SourceImagePage,
    SourceImageUpdate,
    SourceTagCreate,
    SourceTagOut,
    SourceTagUpdate,
    SourceUploadResult,
)

router = APIRouter(prefix="/source-datasets", tags=["source-datasets"])

_MEDIA_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp", ".webp": "image/webp"}


def _dataset_response(dataset) -> SourceDatasetOut:
    return SourceDatasetOut.model_validate(dataset)


def _image_response(image) -> SourceImageOut:
    return SourceImageOut(
        id=image.id,
        file_name=image.file_name,
        width=image.width,
        height=image.height,
        size_bytes=image.size_bytes,
        source_type=image.source_type,
        tags=[SourceTagOut(id=link.tag.id, name=link.tag.name, color=link.tag.color, values=link.tag.values, value=link.value, image_count=0) for link in sorted(image.tag_links, key=lambda link: link.tag.name)],
        file_url=f"/api/source-datasets/{image.source_dataset_id}/images/{image.id}/file",
        thumbnail_url=f"/api/source-datasets/{image.source_dataset_id}/images/{image.id}/thumbnail",
        created_at=image.created_at,
    )


async def _read_upload(file: UploadFile, max_bytes: int) -> bytes:
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise ValidationError("upload_too_large", f"Upload exceeds the {max_bytes // (1024 * 1024)} MB limit.")
    return content


@router.get("", response_model=list[SourceDatasetOut])
def list_source_datasets(session: Session = Depends(get_session)) -> list[SourceDatasetOut]:
    return [_dataset_response(item) for item in service.list_source_datasets(session)]


@router.post("", response_model=SourceDatasetOut, status_code=201)
def create_source_dataset(payload: SourceDatasetCreate, session: Session = Depends(get_session)) -> SourceDatasetOut:
    return _dataset_response(service.create_source_dataset(session, payload))


@router.patch("/{source_dataset_id}", response_model=SourceDatasetOut)
def update_source_dataset(source_dataset_id: str, payload: SourceDatasetUpdate, session: Session = Depends(get_session)) -> SourceDatasetOut:
    return _dataset_response(service.update_source_dataset(session, source_dataset_id, payload))


@router.delete("/{source_dataset_id}", status_code=204, response_class=Response, response_model=None)
def delete_source_dataset(source_dataset_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> None:
    service.delete_source_dataset(session, storage, source_dataset_id)


@router.get("/{source_dataset_id}/images", response_model=SourceImagePage)
def list_images(
    source_dataset_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=60, ge=1, le=500),
    tag_ids: list[str] = Query(default=[]),
    tag_values: str = Query(default=""),
    tag_match: Literal["all", "any"] = Query(default="all"),
    query: str | None = None,
    session: Session = Depends(get_session),
) -> SourceImagePage:
    parsed_tag_values: dict[str, str] = {}
    if tag_values:
        try:
            parsed_tag_values = {str(k): str(v) for k, v in json.loads(tag_values).items()}
        except ValueError:
            parsed_tag_values = {}
    total, items = service.list_images(session, source_dataset_id, offset=offset, limit=limit, tag_ids=tag_ids or None, tag_match=tag_match, tag_values=parsed_tag_values or None, query=query)
    return SourceImagePage(total=total, offset=offset, limit=limit, items=[_image_response(item) for item in items])


@router.post("/{source_dataset_id}/images/upload", response_model=SourceUploadResult, status_code=201)
async def upload_images(
    source_dataset_id: str,
    files: list[UploadFile] = File(...),
    tag_ids: list[str] = Form(default=[]),
    tag_values: str = Form(default=""),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> SourceUploadResult:
    uploads = [(file.filename or "image", await _read_upload(file, settings.max_upload_bytes)) for file in files]
    import json as _json

    parsed_values: dict[str, str] = {}
    if tag_values:
        try:
            parsed_values = {str(k): str(v) for k, v in _json.loads(tag_values).items()}
        except ValueError:
            parsed_values = {}
    return service.add_images(session, storage, settings, source_dataset_id, uploads, "upload", tag_ids=tag_ids or None, tag_values=parsed_values or None)


@router.post("/{source_dataset_id}/images/batch-tags", response_model=SourceBatchTagsResult)
def batch_add_tags(
    source_dataset_id: str,
    payload: SourceBatchTagsRequest,
    session: Session = Depends(get_session),
) -> SourceBatchTagsResult:
    updated = service.apply_tags_to_images(session, source_dataset_id, payload.image_ids, payload.tag_ids, remove=payload.remove, tag_values=payload.tag_values)
    return SourceBatchTagsResult(updated=updated)


@router.post("/{source_dataset_id}/images/ftp-sync")
def ftp_sync(
    source_dataset_id: str,
    payload: SourceFtpSyncRequest,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    # 流开始前先校验数据集存在，让 404 等错误仍走标准 JSON 错误响应。
    service.get_source_dataset(session, source_dataset_id)

    def encode(event: dict) -> str:
        return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    def stream():
        events: queue.Queue[dict | None] = queue.Queue()

        # 同步是阻塞调用，进度回调无法直接 yield，用工作线程 + 队列转发给流。
        def run() -> None:
            try:
                result = service.sync_from_ftp(session, storage, settings, source_dataset_id, payload, on_event=events.put)
                events.put({"type": "done", **result.model_dump()})
            except Exception as exc:
                events.put({
                    "type": "error",
                    "code": getattr(exc, "error_code", "ftp_sync_failed"),
                    "message": getattr(exc, "message", str(exc)),
                })
            finally:
                events.put(None)

        threading.Thread(target=run, daemon=True).start()
        while (event := events.get()) is not None:
            yield encode(event)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.patch("/{source_dataset_id}/images/{image_id}", response_model=SourceImageOut)
def update_image(source_dataset_id: str, image_id: str, payload: SourceImageUpdate, session: Session = Depends(get_session)) -> SourceImageOut:
    return _image_response(service.update_image(session, source_dataset_id, image_id, payload.file_name, payload.tag_ids, payload.tag_values))


@router.delete("/{source_dataset_id}/images/{image_id}", status_code=204, response_class=Response, response_model=None)
def delete_image(source_dataset_id: str, image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> None:
    service.delete_image(session, storage, source_dataset_id, image_id)


@router.get("/{source_dataset_id}/images/{image_id}/file")
def get_image_file(source_dataset_id: str, image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = service.get_image(session, source_dataset_id, image_id)
    path = storage.source_image_path(source_dataset_id, image.storage_name)
    if not path.is_file():
        raise ValidationError("source_image_file_not_found", "图片文件不存在。")
    return FileResponse(path, media_type=_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"), filename=image.file_name)


@router.get("/{source_dataset_id}/images/{image_id}/thumbnail")
def get_image_thumbnail(source_dataset_id: str, image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = service.get_image(session, source_dataset_id, image_id)
    try:
        path = storage.ensure_source_thumbnail(source_dataset_id, image.storage_name)
        media_type = "image/jpeg"
    except ValidationError:
        # 原图损坏等极端情况下退回原图，保证列表有图可显示。
        path = storage.source_image_path(source_dataset_id, image.storage_name)
        if not path.is_file():
            raise
        media_type = _MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{source_dataset_id}/tags", response_model=list[SourceTagOut])
def list_tags(source_dataset_id: str, session: Session = Depends(get_session)) -> list[SourceTagOut]:
    return [SourceTagOut(id=tag.id, name=tag.name, color=tag.color, values=tag.values, image_count=count) for tag, count in service.list_tags(session, source_dataset_id)]


@router.post("/{source_dataset_id}/tags", response_model=SourceTagOut, status_code=201)
def create_tag(source_dataset_id: str, payload: SourceTagCreate, session: Session = Depends(get_session)) -> SourceTagOut:
    tag = service.create_tag(session, source_dataset_id, payload)
    return SourceTagOut(id=tag.id, name=tag.name, color=tag.color, values=tag.values, image_count=0)


@router.patch("/{source_dataset_id}/tags/{tag_id}", response_model=SourceTagOut)
def update_tag(source_dataset_id: str, tag_id: str, payload: SourceTagUpdate, session: Session = Depends(get_session)) -> SourceTagOut:
    tag = service.update_tag(session, source_dataset_id, tag_id, payload)
    counts = {item.id: count for item, count in service.list_tags(session, source_dataset_id)}
    return SourceTagOut(id=tag.id, name=tag.name, color=tag.color, values=tag.values, image_count=counts.get(tag.id, 0))


@router.delete("/{source_dataset_id}/tags/{tag_id}", status_code=204, response_class=Response, response_model=None)
def delete_tag(source_dataset_id: str, tag_id: str, session: Session = Depends(get_session)) -> None:
    service.delete_tag(session, source_dataset_id, tag_id)
