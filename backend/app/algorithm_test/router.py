from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_session, get_settings, get_storage
from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.storage import Storage
from app.core.models import TestDataset, TestImage
from app.algorithm_test import datasets as test_datasets
from app.algorithm_test import expected_annotations as test_annotations
from app.algorithm_test.ftp_import import request_cancel as request_import_cancel, run_async_test_import
from app.algorithm_test.schemas import (
    ReplaceTestAnnotationsRequest,
    TestClassCreate,
    TestClassImportRequest,
    TestClassImportResponse,
    TestClassResponse,
    TestDatasetCreate,
    TestDatasetResponse,
    TestDatasetUpdate,
    TestFtpImportCreate,
    TestImageNeighborsResponse,
    TestImagePage,
    TestImageResponse,
    TestImageUpdate,
    TestUploadResponse,
)

router = APIRouter(prefix="/algorithm-test", tags=["algorithm-test"])
# 图片文件/缩略图独立前缀:路径短、无鉴权耦合,与数据集 file_router 同套路。
file_router = APIRouter(prefix="/algorithm-test/images", tags=["algorithm-test"])


def _dataset_response(dataset: TestDataset) -> TestDatasetResponse:
    response = TestDatasetResponse.model_validate(dataset)
    response.marked_percent = round(dataset.marked_count * 100.0 / dataset.image_count, 1) if dataset.image_count else 0.0
    return response


def _image_response(image: TestImage) -> TestImageResponse:
    return TestImageResponse.model_validate(image)


def _media_type(path: Path) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")


@router.get("/datasets", response_model=list[TestDatasetResponse])
def list_datasets(session: Session = Depends(get_session)) -> list[TestDatasetResponse]:
    return [_dataset_response(item) for item in test_datasets.list_test_datasets(session)]


@router.post("/datasets", response_model=TestDatasetResponse, status_code=201)
def post_dataset(payload: TestDatasetCreate, session: Session = Depends(get_session)) -> TestDatasetResponse:
    return _dataset_response(test_datasets.create_test_dataset(session, payload))


@router.post("/datasets/from-ftp", response_model=TestDatasetResponse, status_code=201)
def create_dataset_from_ftp(
    payload: TestFtpImportCreate,
    request: Request,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> TestDatasetResponse:
    """从 FTP 目录/压缩包异步建测试数据集:占位立即返回,进度轮询列表。"""

    if payload.source == "zip" and not payload.path.lower().endswith(".zip"):
        raise ValidationError("ftp_import_not_zip", "FTP 建集仅支持 .zip 文件或 YOLO 目录。")
    placeholder = TestDataset(
        id=new_id("tds"),
        name=payload.name,
        task_type=payload.task_type,
        source="ftp",
        purpose_tag=payload.purpose_tag,
        ftp_dir=payload.ftp_dir,
        notes=payload.notes,
        import_state="importing",
        import_progress=0.0,
    )
    session.add(placeholder)
    session.commit()
    session.refresh(placeholder)
    run_async_test_import(
        request.app.state.database.session_factory,
        storage,
        settings,
        test_dataset_id=placeholder.id,
        ftp_path=payload.path,
        ftp_source=payload.source,
    )
    return _dataset_response(placeholder)


@router.post("/datasets/{test_dataset_id}/import/cancel", response_model=TestDatasetResponse)
def cancel_dataset_import(test_dataset_id: str, session: Session = Depends(get_session)) -> TestDatasetResponse:
    dataset = test_datasets.get_test_dataset(session, test_dataset_id)
    if dataset.import_state != "importing":
        return _dataset_response(dataset)
    request_import_cancel(test_dataset_id)
    dataset.import_state = "stopped"
    dataset.import_progress = 0.0
    dataset.import_message = "导入已停止。"
    session.commit()
    session.refresh(dataset)
    return _dataset_response(dataset)


@router.get("/datasets/{test_dataset_id}", response_model=TestDatasetResponse)
def get_dataset_detail(test_dataset_id: str, session: Session = Depends(get_session)) -> TestDatasetResponse:
    return _dataset_response(test_datasets.get_test_dataset(session, test_dataset_id))


@router.patch("/datasets/{test_dataset_id}", response_model=TestDatasetResponse)
def patch_dataset(test_dataset_id: str, payload: TestDatasetUpdate, session: Session = Depends(get_session)) -> TestDatasetResponse:
    return _dataset_response(test_datasets.update_test_dataset(session, test_dataset_id, payload))


@router.delete("/datasets/{test_dataset_id}", status_code=204, response_class=Response, response_model=None)
def remove_dataset(test_dataset_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> None:
    test_datasets.delete_test_dataset(session, storage, test_dataset_id)


# ---------------------------------------------------------------------------
# 测试类别库
# ---------------------------------------------------------------------------


@router.get("/datasets/{test_dataset_id}/classes", response_model=list[TestClassResponse])
def get_classes(test_dataset_id: str, session: Session = Depends(get_session)) -> list[TestClassResponse]:
    return [TestClassResponse.model_validate(item) for item in test_datasets.list_test_classes(session, test_dataset_id)]


@router.post("/datasets/{test_dataset_id}/classes", response_model=TestClassResponse, status_code=201)
def post_class(test_dataset_id: str, payload: TestClassCreate, session: Session = Depends(get_session)) -> TestClassResponse:
    return TestClassResponse.model_validate(test_datasets.create_test_class(session, test_dataset_id, payload.name, payload.color))


@router.post("/datasets/{test_dataset_id}/classes/import", response_model=TestClassImportResponse)
def import_classes(test_dataset_id: str, payload: TestClassImportRequest, session: Session = Depends(get_session)) -> TestClassImportResponse:
    imported, skipped = test_datasets.import_templates_into_test_dataset(session, test_dataset_id, payload.template_ids)
    return TestClassImportResponse(imported=[TestClassResponse.model_validate(item) for item in imported], skipped_names=skipped)


@router.delete("/datasets/{test_dataset_id}/classes/{class_id}", status_code=204, response_class=Response, response_model=None)
def remove_class(test_dataset_id: str, class_id: str, session: Session = Depends(get_session)) -> None:
    test_datasets.delete_test_class(session, test_dataset_id, class_id)


# ---------------------------------------------------------------------------
# 测试图片
# ---------------------------------------------------------------------------


@router.post("/datasets/{test_dataset_id}/images/upload", response_model=TestUploadResponse, status_code=201)
async def upload_images(
    test_dataset_id: str,
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> TestUploadResponse:
    uploads: list[tuple[str, bytes]] = []
    total = 0
    for file in files:
        content = await file.read(settings.max_upload_bytes - total + 1)
        total += len(content)
        if total > settings.max_upload_bytes:
            raise ValidationError("upload_too_large", "The combined image upload exceeds the configured limit.")
        uploads.append((file.filename or "image", content))
    items, duplicates = test_datasets.add_uploaded_test_images(session, storage, test_dataset_id, uploads)
    return TestUploadResponse(imported=len(items), duplicates=duplicates, items=[_image_response(item) for item in items])


@router.get("/datasets/{test_dataset_id}/images", response_model=TestImagePage)
def get_images(
    test_dataset_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=1000),
    status: str | None = Query(default=None, pattern="^(unmarked|marked)$"),
    anchor: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> TestImagePage:
    items, total, resolved = test_datasets.list_test_images_page(session, test_dataset_id, offset=offset, limit=limit, status=status, anchor=anchor)
    return TestImagePage(items=[_image_response(item) for item in items], total=total, offset=resolved, limit=limit)


@router.get("/datasets/{test_dataset_id}/images/{image_id}/neighbors", response_model=TestImageNeighborsResponse)
def get_image_neighbors(test_dataset_id: str, image_id: str, session: Session = Depends(get_session)) -> TestImageNeighborsResponse:
    neighbors = test_datasets.get_test_image_neighbors(session, test_dataset_id, image_id)
    return TestImageNeighborsResponse(
        previous=_image_response(neighbors["previous"]) if neighbors["previous"] else None,
        next=_image_response(neighbors["next"]) if neighbors["next"] else None,
        index=neighbors["index"],
        total=neighbors["total"],
    )


@router.patch("/datasets/{test_dataset_id}/images/{image_id}", response_model=TestImageResponse)
def patch_image(test_dataset_id: str, image_id: str, payload: TestImageUpdate, session: Session = Depends(get_session)) -> TestImageResponse:
    return _image_response(test_datasets.update_test_image(session, test_dataset_id, image_id, payload.point_id))


@router.delete("/datasets/{test_dataset_id}/images/{image_id}", status_code=204, response_class=Response, response_model=None)
def remove_image(test_dataset_id: str, image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> None:
    test_datasets.delete_test_image(session, storage, test_dataset_id, image_id)


# ---------------------------------------------------------------------------
# 预期结果标注
# ---------------------------------------------------------------------------


@router.get("/datasets/{test_dataset_id}/images/{image_id}/annotations")
def get_image_annotations(test_dataset_id: str, image_id: str, session: Session = Depends(get_session)):
    return test_annotations.list_test_annotations(session, test_dataset_id, image_id)


@router.put("/datasets/{test_dataset_id}/images/{image_id}/annotations")
def put_image_annotations(
    test_dataset_id: str,
    image_id: str,
    payload: ReplaceTestAnnotationsRequest,
    session: Session = Depends(get_session),
):
    return test_annotations.replace_test_annotations(session, test_dataset_id, image_id, payload.annotations)


# ---------------------------------------------------------------------------
# 图片文件与缩略图(独立 file_router)
# ---------------------------------------------------------------------------


@file_router.get("/{image_id}/file", name="get_test_image_file")
def get_image_file(image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = test_datasets.get_test_image(session, image_id)
    path = storage.test_image_path(image.test_dataset_id, image.storage_name)
    if not path.is_file():
        raise NotFoundError("test_image_file_not_found", "The managed test image file was not found.")
    return FileResponse(path, media_type=_media_type(path), filename=image.file_name)


@file_router.get("/{image_id}/thumbnail", name="get_test_image_thumbnail")
def get_image_thumbnail(image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = test_datasets.get_test_image(session, image_id)
    try:
        thumbnail = storage.ensure_test_thumbnail(image.test_dataset_id, image.id, image.storage_name)
    except ValidationError:
        # 生成失败时退回原图,保证列表仍有图可显示。
        thumbnail = storage.test_image_path(image.test_dataset_id, image.storage_name)
    if not thumbnail.is_file():
        raise NotFoundError("test_image_file_not_found", "The managed test image file was not found.")
    return FileResponse(thumbnail, media_type="image/jpeg")
