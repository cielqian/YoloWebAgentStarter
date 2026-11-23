from __future__ import annotations

import random
from pathlib import Path
from typing import Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import ImageItem
from app.core.schemas import AutoSplitRequest, BulkImageSplitUpdate, ScanImagesResponse, SplitName, SplitOperationResponse
from app.core.storage import SUPPORTED_IMAGE_SUFFIXES, Storage
from app.dataset.service import get_dataset, refresh_dataset_counts
from app.source_dataset.service import list_images as list_source_images


def get_image(session: Session, image_id: str) -> ImageItem:
    image = session.get(ImageItem, image_id)
    if image is None:
        raise NotFoundError("image_not_found", "Image was not found.")
    return image


def list_images(session: Session, dataset_id: str) -> list[ImageItem]:
    get_dataset(session, dataset_id)
    query = select(ImageItem).where(ImageItem.dataset_id == dataset_id).order_by(ImageItem.created_at, ImageItem.id)
    return list(session.scalars(query))


ImageListStatus = Literal["annotated", "unannotated"]


def _ordered_before(created_at, image_id: str):
    """按列表顺序 (created_at, id) 排在指定图片之前的条件。"""
    return or_(
        ImageItem.created_at < created_at,
        and_(ImageItem.created_at == created_at, ImageItem.id < image_id),
    )


def _ordered_after(created_at, image_id: str):
    """按列表顺序 (created_at, id) 排在指定图片之后的条件。"""
    return or_(
        ImageItem.created_at > created_at,
        and_(ImageItem.created_at == created_at, ImageItem.id > image_id),
    )


def list_images_page(
    session: Session,
    dataset_id: str,
    *,
    offset: int = 0,
    limit: int = 200,
    split: SplitName | None = None,
    status: ImageListStatus | None = None,
    anchor: str | None = None,
) -> tuple[list[ImageItem], int, int]:
    """数据库分页的图片列表，返回 (当前页图片, 筛选后的总数, 实际使用的 offset)。

    anchor 给定时返回它所在的那一页（offset 对齐到页首）；它不在筛选结果里则沿用 offset。
    """
    get_dataset(session, dataset_id)
    conditions: list = [ImageItem.dataset_id == dataset_id]
    if split:
        conditions.append(ImageItem.split == split)
    if status:
        conditions.append(ImageItem.status == status)
    resolved = offset
    if anchor:
        target = session.get(ImageItem, anchor)
        if target is not None and target.dataset_id == dataset_id:
            in_result = session.scalar(select(func.count()).select_from(ImageItem).where(*conditions, ImageItem.id == anchor))
            if in_result:
                index = session.scalar(select(func.count()).select_from(ImageItem).where(*conditions, _ordered_before(target.created_at, target.id))) or 0
                resolved = (index // limit) * limit
    total = session.scalar(select(func.count()).select_from(ImageItem).where(*conditions)) or 0
    query = (
        select(ImageItem)
        .where(*conditions)
        .order_by(ImageItem.created_at, ImageItem.id)
        .offset(resolved)
        .limit(limit)
    )
    return list(session.scalars(query)), total, resolved


def get_image_in_dataset(session: Session, dataset_id: str, image_id: str) -> ImageItem:
    image = get_image(session, image_id)
    if image.dataset_id != dataset_id:
        raise NotFoundError("image_not_found", "Image was not found in this dataset.")
    return image


def get_image_neighbors(session: Session, dataset_id: str, image_id: str) -> dict:
    """数据集整体顺序下某张图片的前后邻居及其位置（从 0 计）。

    上一张/下一张按数据集整体顺序走，不随侧栏的 split/状态筛选变化。
    """
    image = get_image_in_dataset(session, dataset_id, image_id)
    scope = ImageItem.dataset_id == dataset_id
    before = _ordered_before(image.created_at, image.id)
    after = _ordered_after(image.created_at, image.id)
    index = session.scalar(select(func.count()).select_from(ImageItem).where(scope, before)) or 0
    total = session.scalar(select(func.count()).select_from(ImageItem).where(scope)) or 0
    previous = session.scalar(
        select(ImageItem).where(scope, before).order_by(ImageItem.created_at.desc(), ImageItem.id.desc()).limit(1)
    )
    next_image = session.scalar(
        select(ImageItem).where(scope, after).order_by(ImageItem.created_at.asc(), ImageItem.id.asc()).limit(1)
    )
    return {"previous": previous, "next": next_image, "index": index, "total": total}


def _stage_image(
    session: Session,
    storage: Storage,
    dataset_id: str,
    original_name: str,
    content: bytes,
    split: SplitName,
) -> ImageItem:
    image_id = new_id("img")
    storage_name = storage.safe_storage_name(original_name, image_id)
    width, height = storage.write_image(dataset_id, storage_name, content)
    image = ImageItem(
        id=image_id,
        dataset_id=dataset_id,
        file_name=Path(original_name).name,
        storage_name=storage_name,
        width=width,
        height=height,
        split=split,
        status="unannotated",
    )
    session.add(image)
    return image


def _md5_hex(content: bytes) -> str:
    import hashlib
    return hashlib.md5(content, usedforsecurity=False).hexdigest()


def add_uploaded_images(
    session: Session,
    storage: Storage,
    dataset_id: str,
    uploads: list[tuple[str, bytes]],
    split: SplitName,
) -> tuple[list[ImageItem], list[str]]:
    """上传图片,MD5 去重:同数据集内已有相同内容的图片跳过,返回 (新图片, 重复文件名列表)。"""
    get_dataset(session, dataset_id)
    # 数据集内已有的 MD5 集合(包括历史上没有记录 checksum 的旧图,按文件内容实时算)
    from app.core.models import ImageItem
    existing_checksums: set[str] = set()
    for row in session.execute(
        select(ImageItem.source_checksum).where(
            ImageItem.dataset_id == dataset_id,
            ImageItem.source_checksum.is_not(None),
        )
    ):
        existing_checksums.add(row[0])

    staged: list[ImageItem] = []
    duplicates: list[str] = []
    batch_seen: set[str] = set()
    try:
        for file_name, content in uploads:
            checksum = _md5_hex(content)
            if checksum in existing_checksums or checksum in batch_seen:
                duplicates.append(file_name)
                continue
            batch_seen.add(checksum)
            image = _stage_image(session, storage, dataset_id, file_name, content, split)
            image.source_checksum = checksum
            staged.append(image)
        session.flush()
        refresh_dataset_counts(session, dataset_id)
        session.commit()
    except Exception:
        session.rollback()
        for image in staged:
            storage.image_path(dataset_id, image.storage_name).unlink(missing_ok=True)
        raise
    for image in staged:
        session.refresh(image)
    return staged, duplicates


def add_images_from_source(
    session: Session,
    storage: Storage,
    dataset_id: str,
    source_dataset_id: str,
    *,
    image_ids: list[str] | None = None,
    tag_ids: list[str] | None = None,
    tag_match: Literal["all", "any"] = "all",
    tag_values: dict[str, str] | None = None,
    split: SplitName,
) -> tuple[list[ImageItem], int]:
    _, source_images = list_source_images(session, source_dataset_id, limit=None, tag_ids=tag_ids, tag_match=tag_match, tag_values=tag_values)
    if image_ids:
        wanted = set(image_ids)
        source_images = [image for image in source_images if image.id in wanted]
        if len(source_images) != len(wanted):
            raise NotFoundError("source_image_not_found", "One or more source images were not found.")
    imported: list[ImageItem] = []
    skipped = 0
    for image in source_images:
        try:
            content = storage.source_image_path(source_dataset_id, image.storage_name).read_bytes()
        except OSError:
            skipped += 1
            continue
        try:
            imported.append(add_uploaded_images(session, storage, dataset_id, [(image.file_name, content)], split)[0])
        except ValidationError:
            skipped += 1
    return imported, skipped


def scan_images(
    session: Session,
    storage: Storage,
    dataset_id: str,
    requested_path: str,
    recursive: bool,
    split: SplitName,
) -> ScanImagesResponse:
    get_dataset(session, dataset_id)
    root = storage.resolve_import_directory(requested_path)
    paths = sorted(path for path in (root.rglob("*") if recursive else root.iterdir()) if path.is_file())
    total_found = len(paths)
    skipped = 0
    invalid = 0
    uploads: list[tuple[str, bytes]] = []
    for path in paths:
        if path.suffix.lower() not in SUPPORTED_IMAGE_SUFFIXES:
            skipped += 1
            continue
        try:
            resolved = storage.resolve_import_file(path)
            uploads.append((path.name, resolved.read_bytes()))
        except (OSError, ValidationError):
            invalid += 1
    imported = 0
    for file_name, content in uploads:
        try:
            add_uploaded_images(session, storage, dataset_id, [(file_name, content)], split)
            imported += 1
        except ValidationError:
            invalid += 1
    return ScanImagesResponse(total_found=total_found, imported=imported, skipped=skipped, invalid=invalid)


def update_image_split(session: Session, image_id: str, split: SplitName) -> ImageItem:
    image = get_image(session, image_id)
    image.split = split
    session.commit()
    session.refresh(image)
    return image


def split_counts(session: Session, dataset_id: str) -> dict[SplitName, int]:
    counts: dict[SplitName, int] = {"train": 0, "val": 0, "test": 0}
    counts.update(dict(session.execute(select(ImageItem.split, func.count(ImageItem.id)).where(ImageItem.dataset_id == dataset_id).group_by(ImageItem.split)).all()))
    return counts


def update_image_splits(session: Session, dataset_id: str, payload: BulkImageSplitUpdate) -> SplitOperationResponse:
    get_dataset(session, dataset_id)
    ids = list(dict.fromkeys(payload.image_ids))
    images = list(session.scalars(select(ImageItem).where(ImageItem.dataset_id == dataset_id, ImageItem.id.in_(ids))))
    if len(images) != len(ids):
        raise NotFoundError("image_not_found", "One or more images were not found in this dataset.")
    for image in images:
        image.split = payload.split
    session.commit()
    return SplitOperationResponse(updated=len(images), split_counts=split_counts(session, dataset_id))


def auto_split_images(session: Session, dataset_id: str, payload: AutoSplitRequest) -> SplitOperationResponse:
    """Adapt upstream DatasetSplitProcessor's deterministic target-balancing for Starter's flat image model."""
    get_dataset(session, dataset_id)
    images = list(session.scalars(select(ImageItem).where(ImageItem.dataset_id == dataset_id).order_by(ImageItem.id)))
    random.Random(payload.seed).shuffle(images)
    ratios = {"train": payload.train_ratio, "val": payload.val_ratio, "test": payload.test_ratio}
    targets = {split: ratio * len(images) for split, ratio in ratios.items()}
    counts = {split: 0 for split in ratios}
    for image in images:
        candidates = [split for split, ratio in ratios.items() if ratio > 0] or ["train"]
        split = min(candidates, key=lambda name: (counts[name] / max(targets[name], 1), ("train", "val", "test").index(name)))
        image.split = split
        counts[split] += 1
    session.commit()
    return SplitOperationResponse(updated=len(images), split_counts=split_counts(session, dataset_id))


def delete_image(session: Session, storage: Storage, image_id: str) -> None:
    image = get_image(session, image_id)
    dataset_id = image.dataset_id
    path = storage.image_path(dataset_id, image.storage_name)
    session.delete(image)
    session.flush()
    refresh_dataset_counts(session, dataset_id)
    session.commit()
    path.unlink(missing_ok=True)
