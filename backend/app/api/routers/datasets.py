from __future__ import annotations

from pathlib import Path

from fastapi import Request, APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import get_session, get_settings, get_storage
from app.class_library.schemas import ClassImportRequest, ClassImportResponse, ClassLabelUpdate
from app.class_library.service import import_templates_into_dataset, update_class_label
from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import Annotation, ClassLabel, Dataset, DatasetVersion, ImageItem
from app.core.schemas import (
    AnnotationResponse,
    AutoSplitRequest,
    BulkImageSplitUpdate,
    ClassLabelCreate,
    ClassLabelResponse,
    DatasetCreate,
    DatasetFtpImportCreate,
    DatasetFtpMergeCreate,
    DatasetImportStarted,
    DatasetMergeResult,
    DatasetMergeStarted,
    DatasetDetailResponse,
    DatasetResponse,
    DatasetUpdate,
    DatasetVersionActivateResponse,
    DatasetVersionCloneCreate,
    DatasetVersionCloneResponse,
    DatasetVersionCreate,
    DatasetVersionRename,
    DatasetVersionResponse,
    DuplicateReport,
    ImageItemResponse,
    ImagePage,
    ImageSplitUpdate,
    PoseConfig,
    ReplaceAnnotationsRequest,
    ScanImagesRequest,
    ScanImagesResponse,
    SourceImportRequest,
    SourceImportResponse,
    SplitOperationResponse,
    TileDatasetRequest,
    TileDatasetResponse,
    SplitName,
    UploadImagesResponse,
    ValidationReport,
    YoloImportResponse,
)
from app.core.storage import SUPPORTED_IMAGE_SUFFIXES, Storage
from app.ftp.service import FtpService
from app.core.task_types import TaskType
from app.dataset.annotation.service import list_annotations, replace_annotations
from app.dataset.import_runner import request_cancel, run_async_import, run_async_merge
from app.dataset.exchange.yolo import YoloArchiveLimits, _tree_zip_bytes, export_dataset, import_dataset, merge_yolo_into_dataset
from app.dataset.exchange.coco import export_coco, import_coco
from app.dataset.quality.schemas import DatasetQualityReport
from app.dataset.quality.service import DatasetQualityService
from app.dataset.images import (
    add_images_from_source,
    add_uploaded_images,
    auto_split_images,
    delete_image,
    get_image,
    list_images,
    scan_images,
    update_image_split,
    update_image_splits,
)
from app.dataset.preparation.duplicates import DuplicateDetector
from app.dataset.preparation.tiling import DatasetTiler
from app.dataset.service import (
    create_class,
    create_dataset,
    delete_class,
    delete_dataset,
    get_dataset,
    list_classes,
    list_datasets,
    update_dataset,
)
from app.dataset.validation import validate_dataset
from app.dataset.versions import (
    activate_version as activate_dataset_version,
    clone_version as clone_dataset_version,
    create_version as create_dataset_version,
    delete_version as delete_dataset_version,
    ensure_editable,
    list_versions as list_dataset_versions,
    rename_version as rename_dataset_version,
    workspace_counts,
)


router = APIRouter(prefix="/datasets", tags=["datasets"])
file_router = APIRouter(prefix="/images", tags=["images"])


def require_editable(dataset_id: str, session: Session = Depends(get_session)) -> None:
    ensure_editable(session, dataset_id)


def _dataset_response(
    dataset: Dataset,
    *,
    annotated_image_count: int = 0,
    latest_version_number: int | None = None,
    active_version_number: int | None = None,
    latest_version_label: str | None = None,
    active_version_label: str | None = None,
) -> DatasetResponse:
    return DatasetResponse(
        id=dataset.id,
        name=dataset.name,
        model_name=dataset.model_name,
        description=dataset.description,
        task_type=dataset.task_type,
        pose_config=PoseConfig.model_validate(dataset.pose_config_json) if dataset.pose_config_json else None,
        image_count=dataset.image_count,
        annotated_image_count=annotated_image_count,
        class_count=dataset.class_count,
        latest_version_number=latest_version_number,
        active_version_number=active_version_number,
        latest_version_label=latest_version_label,
        active_version_label=active_version_label,
        import_state=dataset.import_state,
        import_progress=dataset.import_progress or 0.0,
        import_message=dataset.import_message,
        created_at=dataset.created_at,
        updated_at=dataset.updated_at,
    )


def _dataset_responses(session: Session, datasets: list[Dataset]) -> list[DatasetResponse]:
    if not datasets:
        return []
    ids = [dataset.id for dataset in datasets]
    annotated = dict(
        session.execute(
            select(Annotation.dataset_id, func.count(func.distinct(Annotation.image_id)))
            .where(Annotation.dataset_id.in_(ids))
            .group_by(Annotation.dataset_id)
        ).all()
    )
    latest: dict[str, tuple[int, str]] = {}
    active: dict[str, tuple[int, str]] = {}
    for dataset_id, number, label, is_active in session.execute(
        select(
            DatasetVersion.dataset_id,
            DatasetVersion.version_number,
            DatasetVersion.version_label,
            DatasetVersion.is_active,
        ).where(DatasetVersion.dataset_id.in_(ids))
    ).all():
        if number > latest.get(dataset_id, (0, ""))[0]:
            latest[dataset_id] = (number, label)
        if is_active:
            active[dataset_id] = (number, label)
    return [
        _dataset_response(
            dataset,
            annotated_image_count=annotated.get(dataset.id, 0),
            latest_version_number=latest.get(dataset.id, (None,))[0],
            active_version_number=active.get(dataset.id, (None,))[0],
            latest_version_label=latest.get(dataset.id, (None, None))[1],
            active_version_label=active.get(dataset.id, (None, None))[1],
        )
        for dataset in datasets
    ]


def _class_response(item: ClassLabel) -> ClassLabelResponse:
    return ClassLabelResponse.model_validate(item)


def _image_response(item: ImageItem) -> ImageItemResponse:
    return ImageItemResponse(
        id=item.id,
        dataset_id=item.dataset_id,
        file_name=item.file_name,
        width=item.width,
        height=item.height,
        split=item.split,
        status=item.status,
        source_type=item.source_type,
        source_file=item.source_file,
        source_group_id=item.source_group_id,
        source_video_task_id=item.source_video_task_id,
        source_checksum=item.source_checksum,
        frame_index=item.frame_index,
        timestamp=item.timestamp,
        file_url=f"/api/images/{item.id}/file",
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


async def _read_upload(file: UploadFile, max_bytes: int) -> bytes:
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise ValidationError("upload_too_large", f"Upload exceeds the {max_bytes // (1024 * 1024)} MB limit.")
    return content




def _start_async_import(
    session: Session,
    storage: Storage,
    settings: Settings,
    request: Request,
    *,
    name: str,
    model_name: str | None = None,
    task_type: TaskType,
    description: str | None,
    default_split: str,
    archive_format: str,
    ftp_path: str | None = None,
    ftp_source: str = "zip",
    content: bytes | None = None,
) -> DatasetImportStarted:
    placeholder = Dataset(
        id=new_id("ds"),
        name=name,
        model_name=model_name,
        description=description,
        task_type=task_type.value,
        import_state="importing",
        import_progress=0.0,
    )
    session.add(placeholder)
    session.commit()
    session.refresh(placeholder)
    run_async_import(
        request.app.state.database.session_factory,
        storage,
        settings,
        dataset_id=placeholder.id,
        name=name,
        task_type=task_type,
        description=description,
        default_split=default_split,  # type: ignore[arg-type]
        archive_format=archive_format,
        ftp_path=ftp_path,
        ftp_source=ftp_source,
        content=content,
    )
    return DatasetImportStarted(dataset=_dataset_responses(session, [placeholder])[0])


@router.post("/import/yolo", response_model=YoloImportResponse | DatasetImportStarted, status_code=201)
async def import_yolo_archive(
    file: UploadFile = File(...),
    name: str = Form(...),
    model_name: str | None = Form(default=None),
    task_type: TaskType = Form(...),
    description: str | None = Form(default=None),
    default_split: SplitName = Form(default="train"),
    wait: bool = Query(default=True),
    request: Request = None,  # type: ignore[assignment]
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> YoloImportResponse | DatasetImportStarted:
    content = await _read_upload(file, settings.max_upload_bytes)
    if not name.strip():
        raise ValidationError("dataset_name_required", "Dataset name is required.")
    if not wait:
        return _start_async_import(
            session, storage, settings, request,
            name=name, model_name=model_name, task_type=task_type, description=description,
            default_split=default_split, archive_format="yolo", content=content,
        )
    dataset, imported_images, imported_annotations = import_dataset(
        session,
        storage,
        content,
        DatasetCreate(name=name, model_name=model_name or None, description=description, task_type=task_type),
        default_split,
        limits=YoloArchiveLimits(
            max_members=settings.max_yolo_archive_members,
            max_member_bytes=settings.max_yolo_archive_member_bytes,
            max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
            max_compression_ratio=settings.max_yolo_archive_compression_ratio,
        ),
    )
    return YoloImportResponse(
        dataset=_dataset_responses(session, [dataset])[0],
        imported_images=imported_images,
        imported_annotations=imported_annotations,
    )


@router.post("/import/coco", response_model=YoloImportResponse | DatasetImportStarted, status_code=201)
async def import_coco_archive(
    file: UploadFile = File(...),
    name: str = Form(...),
    model_name: str | None = Form(default=None),
    task_type: TaskType = Form(...),
    description: str | None = Form(default=None),
    wait: bool = Query(default=True),
    request: Request = None,  # type: ignore[assignment]
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> YoloImportResponse | DatasetImportStarted:
    content = await _read_upload(file, settings.max_upload_bytes)
    if not name.strip():
        raise ValidationError("dataset_name_required", "Dataset name is required.")
    if not wait:
        return _start_async_import(
            session, storage, settings, request,
            name=name, model_name=model_name, task_type=task_type, description=description,
            default_split="train", archive_format="coco", content=content,
        )
    dataset, images, annotations = import_coco(
        session,
        storage,
        content,
        DatasetCreate(name=name, model_name=model_name or None, description=description, task_type=task_type),
        limits=YoloArchiveLimits(
            max_members=settings.max_yolo_archive_members,
            max_member_bytes=settings.max_yolo_archive_member_bytes,
            max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
            max_compression_ratio=settings.max_yolo_archive_compression_ratio,
        ),
    )
    return YoloImportResponse(dataset=_dataset_responses(session, [dataset])[0], imported_images=images, imported_annotations=annotations)



def _ftp_yolo_payload(settings: Settings, payload) -> bytes:
    """按 source 类型从 FTP 取回 YOLO 数据：zip 直接返回，目录树打包为 zip。"""
    from app.ftp.service import FtpService

    limits = YoloArchiveLimits(
        max_members=settings.max_yolo_archive_members,
        max_member_bytes=settings.max_yolo_archive_member_bytes,
        max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
        max_compression_ratio=settings.max_yolo_archive_compression_ratio,
    )
    ftp = FtpService(settings)
    if getattr(payload, "source", "zip") == "dir":
        tree, truncated, skipped = ftp.fetch_yolo_tree(
            payload.path,
            recursive=True,
            max_bytes=settings.max_yolo_archive_member_bytes,
            max_files=settings.max_yolo_archive_members,
        )
        if truncated:
            raise ValidationError("ftp_dir_too_many_files", f"目录文件数超过 {settings.max_yolo_archive_members} 上限。")
        if not any(name.lower().endswith(tuple(SUPPORTED_IMAGE_SUFFIXES)) for name in tree):
            raise ValidationError("no_images_in_archive", "FTP 目录中未找到图片文件。")
        return _tree_zip_bytes(tree, limits)
    _, content = ftp.download(payload.path)
    return content

@router.post("/import/from-ftp", response_model=YoloImportResponse | DatasetImportStarted, status_code=201)
def import_archive_from_ftp(
    payload: DatasetFtpImportCreate,
    wait: bool = Query(default=True),
    request: Request = None,  # type: ignore[assignment]
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> YoloImportResponse | DatasetImportStarted:
    if payload.source == "zip" and not payload.path.lower().endswith(".zip"):
        raise ValidationError("ftp_import_not_zip", "FTP 导入仅支持 .zip 文件或 YOLO 目录。")
    if not payload.name.strip():
        raise ValidationError("dataset_name_required", "Dataset name is required.")
    if not wait:
        return _start_async_import(
            session, storage, settings, request,
            name=payload.name, model_name=payload.model_name, task_type=payload.task_type, description=payload.description,
            default_split=payload.default_split, archive_format=payload.format,
            ftp_path=payload.path, ftp_source=payload.source,
        )
    content = _ftp_yolo_payload(settings, payload)
    if len(content) > settings.max_upload_bytes:
        raise ValidationError("upload_too_large", f"FTP 文件超过 {settings.max_upload_bytes // (1024 * 1024)} MB 导入上限。")
    create = DatasetCreate(name=payload.name, model_name=payload.model_name, description=payload.description, task_type=payload.task_type)
    limits = YoloArchiveLimits(
        max_members=settings.max_yolo_archive_members,
        max_member_bytes=settings.max_yolo_archive_member_bytes,
        max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
        max_compression_ratio=settings.max_yolo_archive_compression_ratio,
    )
    if payload.format == "coco":
        dataset, images, annotations = import_coco(session, storage, content, create, limits=limits)
    else:
        dataset, images, annotations = import_dataset(session, storage, content, create, payload.default_split, limits=limits)
    return YoloImportResponse(dataset=_dataset_responses(session, [dataset])[0], imported_images=images, imported_annotations=annotations)


@router.get("", response_model=list[DatasetResponse])
def get_datasets(session: Session = Depends(get_session)) -> list[DatasetResponse]:
    return _dataset_responses(session, list_datasets(session))


@router.post("", response_model=DatasetResponse, status_code=201)
def post_dataset(payload: DatasetCreate, session: Session = Depends(get_session)) -> DatasetResponse:
    return _dataset_response(create_dataset(session, payload))


@router.post("/{dataset_id}/images/merge-from-ftp", response_model=DatasetMergeStarted, status_code=201)
def merge_yolo_from_ftp(
    dataset_id: str,
    payload: DatasetFtpMergeCreate,
    request: Request = None,  # type: ignore[assignment]
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> DatasetMergeStarted:
    """从 FTP 的 ZIP 或 YOLO 目录异步合并进已有数据集。"""
    dataset = get_dataset(session, dataset_id)
    if dataset.import_state in ("importing", "merging"):
        raise ValidationError("import_already_running", "该数据集已有进行中的导入/合并任务。")
    if payload.source == "zip" and not payload.path.lower().endswith(".zip"):
        raise ValidationError("ftp_import_not_zip", "仅支持 .zip 文件或 YOLO 目录。")
    dataset.import_state = "merging"
    dataset.import_progress = 0.0
    dataset.import_message = "正在准备从 FTP 合并…"
    session.commit()
    session.refresh(dataset)
    from app.dataset.import_runner import run_async_merge

    run_async_merge(
        request.app.state.database.session_factory,
        storage,
        dataset_id,
        settings=settings,
        ftp_path=payload.path,
        ftp_source=payload.source,
    )
    return DatasetMergeStarted(dataset=_dataset_responses(session, [dataset])[0])


@router.post("/{dataset_id}/import/cancel", response_model=DatasetDetailResponse)
def cancel_dataset_import(
    dataset_id: str,
    session: Session = Depends(get_session),
) -> DatasetDetailResponse:
    dataset = get_dataset(session, dataset_id)
    if dataset.import_state not in ("importing", "merging"):
        raise ValidationError("import_not_running", "该数据集当前没有进行中的导入或合并。")
    request_cancel(dataset_id)
    dataset.import_message = "正在停止导入…"
    session.commit()
    session.refresh(dataset)
    return get_dataset_detail(dataset_id, session)


@router.post("/{dataset_id}/images/upload-yolo", response_model=DatasetMergeStarted, status_code=201)
async def merge_yolo_archive_into_dataset(
    dataset_id: str,
    file: UploadFile = File(...),
    default_split: SplitName = Form(default="train"),
    request: Request = None,  # type: ignore[assignment]
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> DatasetMergeStarted:
    """向已有数据集异步合并标准 YOLO 压缩包；立即返回，进度见 dataset.import_state=merging。"""
    dataset = get_dataset(session, dataset_id)
    if dataset.import_state in ("importing", "merging"):
        raise ValidationError("import_already_running", "该数据集已有进行中的导入/合并任务。")
    content = await _read_upload(file, settings.max_upload_bytes)
    dataset.import_state = "merging"
    dataset.import_progress = 0.0
    dataset.import_message = "正在合并 YOLO 压缩包…"
    session.commit()
    session.refresh(dataset)
    run_async_merge(request.app.state.database.session_factory, storage, dataset_id, content)
    return DatasetMergeStarted(dataset=_dataset_responses(session, [dataset])[0])


@router.get("/{dataset_id}", response_model=DatasetDetailResponse)
def get_dataset_detail(dataset_id: str, session: Session = Depends(get_session)) -> DatasetDetailResponse:
    dataset = get_dataset(session, dataset_id)
    classes = list_classes(session, dataset_id)
    return DatasetDetailResponse(
        **_dataset_responses(session, [dataset])[0].model_dump(),
        classes=[_class_response(item) for item in classes],
        image_total=dataset.image_count,
    )


@router.patch("/{dataset_id}", response_model=DatasetResponse)
def patch_dataset(dataset_id: str, payload: DatasetUpdate, session: Session = Depends(get_session)) -> DatasetResponse:
    return _dataset_response(update_dataset(session, dataset_id, payload))


@router.delete("/{dataset_id}", status_code=204, response_class=Response, response_model=None)
def remove_dataset(dataset_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> None:
    delete_dataset(session, storage, dataset_id)


@router.get("/{dataset_id}/split-counts", response_model=dict[str, int])
def get_dataset_split_counts(dataset_id: str, session: Session = Depends(get_session)) -> dict[str, int]:
    from app.dataset.images import split_counts

    get_dataset(session, dataset_id)
    return split_counts(session, dataset_id)


@router.get("/{dataset_id}/versions", response_model=list[DatasetVersionResponse])
def get_dataset_versions(dataset_id: str, session: Session = Depends(get_session)) -> list[DatasetVersionResponse]:
    versions = list_dataset_versions(session, dataset_id)
    responses = [DatasetVersionResponse.model_validate(item) for item in versions]
    index = next((i for i, item in enumerate(responses) if item.is_active), None)
    if index is not None:
        # 激活中的版本展示工作区实时统计，快照数字保持冻结以保证回滚语义
        live = workspace_counts(session, dataset_id)
        snapshot = versions[index]
        responses[index].image_count, responses[index].annotation_count, responses[index].class_count = live
        responses[index].has_pending_changes = live != (
            snapshot.image_count,
            snapshot.annotation_count,
            snapshot.class_count,
        )
    return responses


@router.post("/{dataset_id}/clone", response_model=DatasetVersionCloneResponse, status_code=201)
def post_clone_dataset(
    dataset_id: str,
    payload: DatasetVersionCloneCreate,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> DatasetVersionCloneResponse:
    dataset, imported, annotations, skipped = clone_dataset_version(
        session, storage, dataset_id, payload.version_id, payload.name, payload.description
    )
    return DatasetVersionCloneResponse(
        dataset=_dataset_responses(session, [dataset])[0],
        imported_images=imported,
        imported_annotations=annotations,
        skipped_images=skipped,
    )


@router.post("/{dataset_id}/versions", response_model=DatasetVersionResponse, status_code=201)
def post_dataset_version(
    dataset_id: str,
    payload: DatasetVersionCreate,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> DatasetVersionResponse:
    return create_dataset_version(session, storage, dataset_id, payload.note, payload.version_label)


@router.patch("/{dataset_id}/versions/{version_id}", response_model=DatasetVersionResponse)
def patch_dataset_version(
    dataset_id: str,
    version_id: str,
    payload: DatasetVersionRename,
    session: Session = Depends(get_session),
) -> DatasetVersionResponse:
    return DatasetVersionResponse.model_validate(rename_dataset_version(session, dataset_id, version_id, payload.version_label))


@router.post("/{dataset_id}/versions/{version_id}/activate", response_model=DatasetVersionActivateResponse)
def post_activate_dataset_version(
    dataset_id: str,
    version_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> DatasetVersionActivateResponse:
    version, restored, skipped = activate_dataset_version(session, storage, dataset_id, version_id)
    return DatasetVersionActivateResponse(
        version=DatasetVersionResponse.model_validate(version),
        restored_images=restored,
        skipped_images=skipped,
    )


@router.post("/{dataset_id}/versions/{version_id}/clone", response_model=DatasetVersionCloneResponse, status_code=201)
def post_clone_dataset_version(
    dataset_id: str,
    version_id: str,
    payload: DatasetVersionCloneCreate,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> DatasetVersionCloneResponse:
    dataset, imported, annotations, skipped = clone_dataset_version(
        session, storage, dataset_id, version_id, payload.name, payload.description
    )
    return DatasetVersionCloneResponse(
        dataset=_dataset_responses(session, [dataset])[0],
        imported_images=imported,
        imported_annotations=annotations,
        skipped_images=skipped,
    )


@router.delete("/{dataset_id}/versions/{version_id}", status_code=204, response_class=Response, response_model=None)
def remove_dataset_version(
    dataset_id: str,
    version_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> None:
    delete_dataset_version(session, storage, dataset_id, version_id)


@router.get("/{dataset_id}/classes", response_model=list[ClassLabelResponse])
def get_classes(dataset_id: str, session: Session = Depends(get_session)) -> list[ClassLabelResponse]:
    return [_class_response(item) for item in list_classes(session, dataset_id)]


@router.post("/{dataset_id}/classes", response_model=ClassLabelResponse, status_code=201, dependencies=[Depends(require_editable)])
def post_class(
    dataset_id: str,
    payload: ClassLabelCreate,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClassLabelResponse:
    return _class_response(create_class(session, dataset_id, payload, settings))


@router.patch("/{dataset_id}/classes/{class_id}", response_model=ClassLabelResponse, dependencies=[Depends(require_editable)])
def patch_class(
    dataset_id: str,
    class_id: str,
    payload: ClassLabelUpdate,
    session: Session = Depends(get_session),
) -> ClassLabelResponse:
    return _class_response(update_class_label(session, dataset_id, class_id, payload))


@router.post("/{dataset_id}/classes/import", response_model=ClassImportResponse, dependencies=[Depends(require_editable)])
def import_classes(
    dataset_id: str,
    payload: ClassImportRequest,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClassImportResponse:
    imported, skipped = import_templates_into_dataset(session, dataset_id, payload.template_ids, settings)
    return ClassImportResponse(
        imported=[_class_response(item) for item in imported],
        skipped_names=skipped,
    )


@router.delete("/{dataset_id}/classes/{class_id}", status_code=204, response_class=Response, response_model=None, dependencies=[Depends(require_editable)])
def remove_class(dataset_id: str, class_id: str, session: Session = Depends(get_session)) -> None:
    delete_class(session, dataset_id, class_id)


@router.get("/{dataset_id}/images", response_model=ImagePage)
def get_images(
    dataset_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> ImagePage:
    # 分页下推到数据库:此前每次请求都整表加载再切片,大库下每页都要全量读。
    get_dataset(session, dataset_id)
    total = session.scalar(select(func.count()).select_from(ImageItem).where(ImageItem.dataset_id == dataset_id)) or 0
    query = (
        select(ImageItem)
        .where(ImageItem.dataset_id == dataset_id)
        .order_by(ImageItem.created_at, ImageItem.id)
        .offset(offset)
        .limit(limit)
    )
    items = list(session.scalars(query))
    return ImagePage(items=[_image_response(item) for item in items], total=total)


@router.post("/{dataset_id}/images/upload", response_model=UploadImagesResponse, status_code=201, dependencies=[Depends(require_editable)])
async def upload_images(
    dataset_id: str,
    files: list[UploadFile] = File(...),
    split: SplitName = Form(default="train"),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> UploadImagesResponse:
    uploads: list[tuple[str, bytes]] = []
    total = 0
    for file in files:
        content = await file.read(settings.max_upload_bytes - total + 1)
        total += len(content)
        if total > settings.max_upload_bytes:
            raise ValidationError("upload_too_large", "The combined image upload exceeds the configured limit.")
        uploads.append((file.filename or "image", content))
    items = add_uploaded_images(session, storage, dataset_id, uploads, split)
    return UploadImagesResponse(imported=len(items), items=[_image_response(item) for item in items])


@router.post("/{dataset_id}/images/from-source", response_model=SourceImportResponse, status_code=201, dependencies=[Depends(require_editable)])
def import_images_from_source(
    dataset_id: str,
    payload: SourceImportRequest,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> SourceImportResponse:
    items, skipped = add_images_from_source(
        session,
        storage,
        dataset_id,
        payload.source_dataset_id,
        image_ids=payload.image_ids,
        tag_ids=payload.tag_ids,
        tag_match=payload.tag_match,
        tag_values=payload.tag_values,
        split=payload.split,
    )
    return SourceImportResponse(imported=len(items), skipped=skipped)


@router.post("/{dataset_id}/images/scan", response_model=ScanImagesResponse, dependencies=[Depends(require_editable)])
def scan_dataset_images(
    dataset_id: str,
    payload: ScanImagesRequest,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ScanImagesResponse:
    return scan_images(session, storage, dataset_id, payload.path, payload.recursive, payload.split)


@router.patch("/{dataset_id}/images/{image_id}", response_model=ImageItemResponse, dependencies=[Depends(require_editable)])
def patch_image(
    dataset_id: str,
    image_id: str,
    payload: ImageSplitUpdate,
    session: Session = Depends(get_session),
) -> ImageItemResponse:
    image = get_image(session, image_id)
    if image.dataset_id != dataset_id:
        raise NotFoundError("image_not_found", "Image was not found in this dataset.")
    return _image_response(update_image_split(session, image_id, payload.split))


@router.post("/{dataset_id}/images/bulk-split", response_model=SplitOperationResponse, dependencies=[Depends(require_editable)])
def bulk_update_image_split(dataset_id: str, payload: BulkImageSplitUpdate, session: Session = Depends(get_session)) -> SplitOperationResponse:
    return update_image_splits(session, dataset_id, payload)


@router.post("/{dataset_id}/images/auto-split", response_model=SplitOperationResponse, dependencies=[Depends(require_editable)])
def auto_split_dataset_images(dataset_id: str, payload: AutoSplitRequest, session: Session = Depends(get_session)) -> SplitOperationResponse:
    return auto_split_images(session, dataset_id, payload)


@router.delete("/{dataset_id}/images/{image_id}", status_code=204, response_class=Response, response_model=None, dependencies=[Depends(require_editable)])
def remove_image(
    dataset_id: str,
    image_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> None:
    image = get_image(session, image_id)
    if image.dataset_id != dataset_id:
        raise NotFoundError("image_not_found", "Image was not found in this dataset.")
    delete_image(session, storage, image_id)


@router.get("/{dataset_id}/images/{image_id}/annotations", response_model=list[AnnotationResponse])
def get_image_annotations(dataset_id: str, image_id: str, session: Session = Depends(get_session)) -> list[AnnotationResponse]:
    image = get_image(session, image_id)
    if image.dataset_id != dataset_id:
        raise NotFoundError("image_not_found", "Image was not found in this dataset.")
    return list_annotations(session, image_id)


@router.put("/{dataset_id}/images/{image_id}/annotations", response_model=list[AnnotationResponse], dependencies=[Depends(require_editable)])
def put_image_annotations(
    dataset_id: str,
    image_id: str,
    payload: ReplaceAnnotationsRequest,
    session: Session = Depends(get_session),
) -> list[AnnotationResponse]:
    image = get_image(session, image_id)
    if image.dataset_id != dataset_id:
        raise NotFoundError("image_not_found", "Image was not found in this dataset.")
    return replace_annotations(session, image_id, payload.annotations)


@router.post("/{dataset_id}/validate", response_model=ValidationReport)
def validate_dataset_route(
    dataset_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> ValidationReport:
    return validate_dataset(session, storage, dataset_id)


@router.get("/{dataset_id}/quality/report", response_model=DatasetQualityReport)
def get_dataset_quality_report(dataset_id: str, session: Session = Depends(get_session)) -> DatasetQualityReport:
    return DatasetQualityService().report(session, dataset_id)


@router.get("/{dataset_id}/duplicates", response_model=DuplicateReport)
def get_duplicate_report(
    dataset_id: str,
    phash_distance: int = Query(default=8, ge=0, le=64),
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> DuplicateReport:
    return DuplicateReport.model_validate(DuplicateDetector().analyze(list_images(session, dataset_id), storage, phash_distance))


@router.post("/{dataset_id}/tile", response_model=TileDatasetResponse, status_code=201, dependencies=[Depends(require_editable)])
def tile_dataset(
    dataset_id: str,
    payload: TileDatasetRequest,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> TileDatasetResponse:
    return DatasetTiler().create(session, storage, dataset_id, payload)


@router.get("/{dataset_id}/export/yolo")
def export_yolo_archive(
    dataset_id: str,
    session: Session = Depends(get_session),
    storage: Storage = Depends(get_storage),
) -> FileResponse:
    content, file_name = export_dataset(session, storage, dataset_id)
    output_path = storage.export_path(f"{new_id('yolo')}_{Path(file_name).name}")
    output_path.write_bytes(content)
    return FileResponse(output_path, media_type="application/zip", filename=file_name)


@router.get("/{dataset_id}/export/coco")
def export_coco_archive(dataset_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    content, file_name = export_coco(session, storage, dataset_id)
    output_path = storage.export_path(f"{new_id('coco')}_{Path(file_name).name}")
    output_path.write_bytes(content)
    return FileResponse(output_path, media_type="application/zip", filename=file_name)


@file_router.get("/{image_id}/file", name="get_image_file")
def get_image_file(image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = get_image(session, image_id)
    path = storage.image_path(image.dataset_id, image.storage_name)
    if not path.is_file():
        raise NotFoundError("image_file_not_found", "The managed image file was not found.")
    return FileResponse(path, media_type=_media_type(path), filename=image.file_name)


@file_router.get("/{image_id}/thumbnail", name="get_image_thumbnail")
def get_image_thumbnail(image_id: str, session: Session = Depends(get_session), storage: Storage = Depends(get_storage)) -> FileResponse:
    image = get_image(session, image_id)
    try:
        thumbnail = storage.ensure_dataset_thumbnail(image.dataset_id, image.id, image.storage_name)
    except ValidationError:
        # 生成失败时退回原图，保证列表仍有图可显示。
        thumbnail = storage.image_path(image.dataset_id, image.storage_name)
    if not thumbnail.is_file():
        raise NotFoundError("image_file_not_found", "The managed image file was not found.")
    return FileResponse(thumbnail, media_type="image/jpeg")


def _media_type(path: Path) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")
