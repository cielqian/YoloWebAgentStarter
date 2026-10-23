from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Literal

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


def _owned_tags(session: Session, source_dataset_id: str, tag_ids: list[str]) -> list[SourceTag]:
    tags = list(
        session.scalars(
            select(SourceTag).where(
                SourceTag.source_dataset_id == source_dataset_id, SourceTag.id.in_(tag_ids)
            )
        )
    )
    if len(tags) != len(set(tag_ids)):
        raise NotFoundError("source_tag_not_found", "标签不存在或不属于该数据源数据集。")
    return sorted(tags, key=lambda tag: tag.name)


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
    tag_ids: list[str] | None = None,
    tag_values: dict[str, str] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> SourceUploadResult:
    get_source_dataset(session, source_dataset_id)
    tags = _owned_tags(session, source_dataset_id, tag_ids) if tag_ids else []
    if tag_values:
        _validate_enum_values(session, source_dataset_id, tag_values)
    staged: list[SourceImage] = []
    invalid = 0
    for file_name, content in uploads:
        try:
            staged.append(_stage_image(session, storage, source_dataset_id, file_name, content, source_type, settings.max_upload_bytes))
        except ValidationError:
            invalid += 1
        if on_progress is not None:
            on_progress(len(staged), invalid)
    for image in staged:
        image.tag_links = [
            SourceImageTag(image_id=image.id, tag_id=tag.id, value=(tag_values or {}).get(tag.id) if tag.values else None)
            for tag in tags
        ]
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
    on_event: Callable[[dict], None] | None = None,
) -> SourceFtpSyncResult:
    def emit(event: dict) -> None:
        if on_event is not None:
            on_event(event)

    tag_ids = payload.tag_ids or None
    get_source_dataset(session, source_dataset_id)
    # 先校验标签再下载，避免整目录拉完后才发现标签不合法。
    if tag_ids:
        _owned_tags(session, source_dataset_id, tag_ids)
    emit({"type": "progress", "stage": "download", "synced": 0, "skipped": 0})
    if payload.file_paths:
        files, skipped = FtpService(settings).fetch_files(
            payload.file_paths,
            max_bytes=settings.max_upload_bytes,
            on_progress=lambda synced, skipped_so_far: emit(
                {"type": "progress", "stage": "download", "synced": synced, "skipped": skipped_so_far}
            ),
        )
        result = add_images(
            session, storage, settings, source_dataset_id, files, "ftp", tag_ids=tag_ids, tag_values=payload.tag_values,
            on_progress=lambda saved, invalid: emit({"type": "progress", "stage": "save", "synced": saved, "skipped": invalid}),
        )
        return SourceFtpSyncResult(synced=result.imported, skipped=result.invalid + skipped)
    files, truncated = FtpService(settings).fetch_directory_images(
        payload.path,
        recursive=payload.recursive,
        max_bytes=settings.max_upload_bytes,
        max_files=settings.ftp_sync_max_files,
        on_progress=lambda synced: emit({"type": "progress", "stage": "download", "synced": synced, "skipped": 0}),
    )
    result = add_images(
        session, storage, settings, source_dataset_id, files, "ftp", tag_ids=tag_ids, tag_values=payload.tag_values,
        on_progress=lambda saved, invalid: emit({"type": "progress", "stage": "save", "synced": saved, "skipped": invalid}),
    )
    return SourceFtpSyncResult(synced=result.imported, skipped=result.invalid, truncated=truncated)


def list_images(
    session: Session,
    source_dataset_id: str,
    *,
    offset: int = 0,
    limit: int | None = 60,
    tag_ids: list[str] | None = None,
    tag_match: Literal["all", "any"] = "all",
    tag_values: dict[str, str] | None = None,
    query: str | None = None,
) -> tuple[int, list[SourceImage]]:
    get_source_dataset(session, source_dataset_id)
    conditions = [SourceImage.source_dataset_id == source_dataset_id]
    if tag_ids and tag_match == "any":
        conditions.append(SourceImage.id.in_(select(SourceImageTag.image_id).where(SourceImageTag.tag_id.in_(tag_ids))))
    else:
        for tag_id in dict.fromkeys(tag_ids or []):
            conditions.append(SourceImage.id.in_(select(SourceImageTag.image_id).where(SourceImageTag.tag_id == tag_id)))
    for tag_id, value in (tag_values or {}).items():
        conditions.append(
            SourceImage.id.in_(
                select(SourceImageTag.image_id).where(SourceImageTag.tag_id == tag_id, SourceImageTag.value == value)
            )
        )
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



def _set_image_tags(session: Session, image: SourceImage, tag_ids: list[str], values_by_tag: dict[str, str] | None = None) -> None:
    """整体替换图片标签关联;枚举标签记录所选 value。"""
    from app.core.models import SourceImageTag

    tags = _owned_tags(session, image.source_dataset_id, tag_ids)
    by_id = {tag.id: tag for tag in tags}
    image.tag_links = [
        SourceImageTag(image_id=image.id, tag_id=tag.id, value=(values_by_tag or {}).get(tag.id) if tag.values else None)
        for tag in tags
    ]


def _validate_enum_values(session: Session, source_dataset_id: str, values_by_tag: dict[str, str]) -> None:
    if not values_by_tag:
        return
    tags = _owned_tags(session, source_dataset_id, list(values_by_tag.keys()))
    by_id = {tag.id: tag for tag in tags}
    for tag_id, value in values_by_tag.items():
        tag = by_id.get(tag_id)
        if tag is not None and tag.values and value not in tag.values:
            raise ValidationError("tag_value_invalid", f"标签“{tag.name}”的值必须是 {' / '.join(tag.values)} 之一。")

def update_image(session: Session, source_dataset_id: str, image_id: str, file_name: str | None, tag_ids: list[str] | None, tag_values: dict[str, str] | None = None) -> SourceImage:
    image = get_image(session, source_dataset_id, image_id)
    if file_name is not None:
        image.file_name = Path(file_name).name
    if tag_ids is not None:
        _validate_enum_values(session, source_dataset_id, tag_values or {})
        _set_image_tags(session, image, tag_ids, tag_values)
    session.commit()
    session.refresh(image)
    return image


def apply_tags_to_images(session: Session, source_dataset_id: str, image_ids: list[str], tag_ids: list[str], *, remove: bool, tag_values: dict[str, str] | None = None) -> int:
    """批量为多张图片关联或取消关联标签；关联时保留已有标签，枚举标签记录所选取值(重复应用时更新取值)。"""
    get_source_dataset(session, source_dataset_id)
    tags = _owned_tags(session, source_dataset_id, tag_ids)
    _validate_enum_values(session, source_dataset_id, tag_values or {})
    images = list(
        session.scalars(
            select(SourceImage).where(
                SourceImage.source_dataset_id == source_dataset_id, SourceImage.id.in_(image_ids)
            )
        )
    )
    if len(images) != len(set(image_ids)):
        raise NotFoundError("source_image_not_found", "图片不存在或不属于该数据源数据集。")
    from app.core.models import SourceImageTag

    values_by_tag = tag_values or {}
    for image in images:
        if remove:
            image.tag_links = [link for link in image.tag_links if link.tag_id not in {tag.id for tag in tags}]
        else:
            existing = {link.tag_id: link for link in image.tag_links}
            for tag in tags:
                link = existing.get(tag.id)
                if link is None:
                    image.tag_links.append(SourceImageTag(image_id=image.id, tag_id=tag.id, value=values_by_tag.get(tag.id) if tag.values else None))
                elif tag.values and values_by_tag.get(tag.id):
                    link.value = values_by_tag[tag.id]
    session.commit()
    return len(images)


def delete_image(session: Session, storage: Storage, source_dataset_id: str, image_id: str) -> None:
    image = get_image(session, source_dataset_id, image_id)
    path = storage.source_image_path(source_dataset_id, image.storage_name)
    session.delete(image)
    _refresh_counts(session, source_dataset_id)
    session.commit()
    path.unlink(missing_ok=True)


def list_tags(session: Session, source_dataset_id: str) -> list[tuple[SourceTag, int]]:
    get_source_dataset(session, source_dataset_id)
    # 标签定义直接取全局标签库;同名落库到 source tag 以承载图片关联与计数
    from app.core.models import TagTemplate

    templates = list(session.scalars(select(TagTemplate).order_by(TagTemplate.name)))
    if templates:
        existing = {
            tag.name: tag
            for tag in session.scalars(select(SourceTag).where(SourceTag.source_dataset_id == source_dataset_id))
        }
        for template in templates:
            found = existing.get(template.name)
            if found is None:
                found = SourceTag(id=new_id("stag"), source_dataset_id=source_dataset_id, name=template.name, color=template.color, values=template.values)
                session.add(found)
                existing[template.name] = found
            else:
                found.color = template.color
                found.values = template.values
        session.commit()
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
    values = [value.strip() for value in (payload.values or []) if value.strip()] or None
    tag = SourceTag(id=new_id("stag"), source_dataset_id=source_dataset_id, name=payload.name, color=payload.color, values=values)
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
