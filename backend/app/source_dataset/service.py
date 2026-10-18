from __future__ import annotations

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import SourceDataset, SourceImage, SourceImageTag, SourceTag
from app.core.storage import Storage
from app.ftp.service import FtpService
from app.source_dataset.schemas import (
    SourceDatasetCreate,
    SourceDatasetUpdate,
    SourceFtpSyncRequest,
    SourceFtpSyncResult,
    SourceTagCreate,
    SourceTagUpdate,
    SourceUploadResult,
)


def get_source_dataset(session: Session, source_dataset_id: str) -> SourceDataset:
    dataset = session.get(SourceDataset, source_dataset_id)
    if dataset is None:
        raise NotFoundError("source_dataset_not_found", "数据源数据集不存在。")
    return dataset


def _refresh_counts(session: Session, source_dataset_id: str, *, commit: bool = False) -> None:
    dataset = get_source_dataset(session, source_dataset_id)
    dataset.image_count = session.scalar(
        select(func.count()).select_from(SourceImage).where(SourceImage.source_dataset_id == source_dataset_id)
    ) or 0
    dataset.tag_count = session.scalar(
        select(func.count()).select_from(SourceTag).where(SourceTag.source_dataset_id == source_dataset_id)
    ) or 0
    if commit:
        session.commit()


def list_source_datasets(session: Session) -> list[SourceDataset]:
    return list(session.scalars(select(SourceDataset).order_by(SourceDataset.created_at.desc())))


def create_source_dataset(session: Session, payload: SourceDatasetCreate) -> SourceDataset:
    dataset = SourceDataset(id=new_id("sd"), name=payload.name, description=payload.description)
    session.add(dataset)
    session.commit()
    session.refresh(dataset)
    return dataset


def update_source_dataset(session: Session, source_dataset_id: str, payload: SourceDatasetUpdate) -> SourceDataset:
    dataset = get_source_dataset(session, source_dataset_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(dataset, field, value)
    session.commit()
    session.refresh(dataset)
    return dataset


def delete_source_dataset(session: Session, storage: Storage, source_dataset_id: str) -> None:
    dataset = get_source_dataset(session, source_dataset_id)
    session.delete(dataset)
    session.commit()
    storage.remove_source_dataset(source_dataset_id)


def _stage_image(
    session: Session,
    storage: Storage,
    source_dataset_id: str,
    original_name: str,
    content: bytes,
    source_type: str,
    max_bytes: int,
) -> SourceImage:
    image_id = new_id("simg")
    storage_name = storage.safe_storage_name(original_name, image_id)
    width, height = storage.write_source_image(source_dataset_id, storage_name, content, max_bytes=max_bytes)
    image = SourceImage(
        id=image_id,
        source_dataset_id=source_dataset_id,
        file_name=Path(original_name).name,
        storage_name=storage_name,
        width=width,
        height=height,
        size_bytes=len(content),
        source_type=source_type,
    )
    session.add(image)
    return image


def add_images(
    session: Session,
    storage: Storage,
    settings: Settings,
    source_dataset_id: str,
    uploads: list[tuple[str, bytes]],
    source_type: str,
) -> SourceUploadResult:
    get_source_dataset(session, source_dataset_id)
    staged: list[SourceImage] = []
    invalid = 0
    for file_name, content in uploads:
        try:
            staged.append(_stage_image(session, storage, source_dataset_id, file_name, content, source_type, settings.max_upload_bytes))
        except ValidationError:
            invalid += 1
    try:
        session.flush()
        _refresh_counts(session, source_dataset_id)
        session.commit()
    except Exception:
        session.rollback()
        for image in staged:
            storage.source_image_path(source_dataset_id, image.storage_name).unlink(missing_ok=True)
        raise
    for image in staged:
        session.refresh(image)
    return SourceUploadResult(imported=len(staged), invalid=invalid)


def sync_from_ftp(
    session: Session,
    storage: Storage,
    settings: Settings,
    source_dataset_id: str,
    payload: SourceFtpSyncRequest,
) -> SourceFtpSyncResult:
    files = FtpService(settings).fetch_directory_images(
        payload.path, recursive=payload.recursive, max_bytes=settings.max_upload_bytes
    )
    result = add_images(session, storage, settings, source_dataset_id, files, "ftp")
    return SourceFtpSyncResult(synced=result.imported, skipped=result.invalid)


def list_images(
    session: Session,
    source_dataset_id: str,
    *,
    offset: int = 0,
    limit: int = 60,
    tag_id: str | None = None,
    query: str | None = None,
) -> tuple[int, list[SourceImage]]:
    get_source_dataset(session, source_dataset_id)
    conditions = [SourceImage.source_dataset_id == source_dataset_id]
    if tag_id:
        conditions.append(SourceImage.id.in_(select(SourceImageTag.image_id).where(SourceImageTag.tag_id == tag_id)))
    if query:
        conditions.append(SourceImage.file_name.ilike(f"%{query}%"))
    total = session.scalar(select(func.count()).select_from(SourceImage).where(*conditions)) or 0
    items = list(
        session.scalars(
            select(SourceImage)
            .where(*conditions)
            .order_by(SourceImage.created_at.desc(), SourceImage.id)
            .offset(offset)
            .limit(limit)
        )
    )
    return total, items


def get_image(session: Session, source_dataset_id: str, image_id: str) -> SourceImage:
    image = session.get(SourceImage, image_id)
    if image is None or image.source_dataset_id != source_dataset_id:
        raise NotFoundError("source_image_not_found", "图片不存在或不属于该数据源数据集。")
    return image


def update_image(session: Session, source_dataset_id: str, image_id: str, file_name: str | None, tag_ids: list[str] | None) -> SourceImage:
    image = get_image(session, source_dataset_id, image_id)
    if file_name is not None:
        image.file_name = Path(file_name).name
    if tag_ids is not None:
        tags = list(
            session.scalars(
                select(SourceTag).where(
                    SourceTag.source_dataset_id == source_dataset_id, SourceTag.id.in_(tag_ids)
                )
            )
        )
        if len(tags) != len(set(tag_ids)):
            raise NotFoundError("source_tag_not_found", "标签不存在或不属于该数据源数据集。")
        image.tags = sorted(tags, key=lambda tag: tag.name)
    session.commit()
    session.refresh(image)
    return image


def delete_image(session: Session, storage: Storage, source_dataset_id: str, image_id: str) -> None:
    image = get_image(session, source_dataset_id, image_id)
    path = storage.source_image_path(source_dataset_id, image.storage_name)
    session.delete(image)
    _refresh_counts(session, source_dataset_id)
    session.commit()
    path.unlink(missing_ok=True)


def list_tags(session: Session, source_dataset_id: str) -> list[tuple[SourceTag, int]]:
    get_source_dataset(session, source_dataset_id)
    tags = list(
        session.scalars(
            select(SourceTag).where(SourceTag.source_dataset_id == source_dataset_id).order_by(SourceTag.name)
        )
    )
    counts = dict(
        session.execute(
            select(SourceImageTag.tag_id, func.count())
            .join(SourceImage, SourceImage.id == SourceImageTag.image_id)
            .where(SourceImage.source_dataset_id == source_dataset_id)
            .group_by(SourceImageTag.tag_id)
        ).all()
    )
    return [(tag, counts.get(tag.id, 0)) for tag in tags]


def _get_tag(session: Session, source_dataset_id: str, tag_id: str) -> SourceTag:
    tag = session.get(SourceTag, tag_id)
    if tag is None or tag.source_dataset_id != source_dataset_id:
        raise NotFoundError("source_tag_not_found", "标签不存在或不属于该数据源数据集。")
    return tag


def create_tag(session: Session, source_dataset_id: str, payload: SourceTagCreate) -> SourceTag:
    get_source_dataset(session, source_dataset_id)
    tag = SourceTag(id=new_id("stag"), source_dataset_id=source_dataset_id, name=payload.name, color=payload.color)
    session.add(tag)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise ConflictError("source_tag_conflict", "同名标签已存在。") from None
    _refresh_counts(session, source_dataset_id)
    session.commit()
    session.refresh(tag)
    return tag


def update_tag(session: Session, source_dataset_id: str, tag_id: str, payload: SourceTagUpdate) -> SourceTag:
    tag = _get_tag(session, source_dataset_id, tag_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(tag, field, value)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise ConflictError("source_tag_conflict", "同名标签已存在。") from None
    session.refresh(tag)
    return tag


def delete_tag(session: Session, source_dataset_id: str, tag_id: str) -> None:
    tag = _get_tag(session, source_dataset_id, tag_id)
    session.delete(tag)
    _refresh_counts(session, source_dataset_id)
    session.commit()
