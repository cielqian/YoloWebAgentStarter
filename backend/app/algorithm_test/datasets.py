from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import ClassTemplate, TestClassLabel, TestDataset, TestImage
from app.core.storage import Storage
from app.algorithm_test.schemas import TestDatasetCreate, TestDatasetUpdate


def get_test_dataset(session: Session, test_dataset_id: str) -> TestDataset:
    dataset = session.get(TestDataset, test_dataset_id)
    if dataset is None:
        raise NotFoundError("test_dataset_not_found", "Test dataset was not found.")
    return dataset


def require_editable(session: Session, test_dataset_id: str) -> None:
    dataset = get_test_dataset(session, test_dataset_id)
    if dataset.status == "locked":
        raise ConflictError("test_dataset_locked", "A test task is running on this dataset; changes are blocked.")


def list_test_datasets(session: Session) -> list[TestDataset]:
    return list(session.scalars(select(TestDataset).order_by(TestDataset.created_at.desc())))


def create_test_dataset(session: Session, payload: TestDatasetCreate, *, source: str = "local") -> TestDataset:
    dataset = TestDataset(
        id=new_id("tds"),
        name=payload.name,
        task_type=payload.task_type,
        source=source,
        purpose_tag=payload.purpose_tag,
        ftp_dir=payload.ftp_dir,
        notes=payload.notes,
    )
    session.add(dataset)
    session.commit()
    session.refresh(dataset)
    return dataset


def update_test_dataset(session: Session, test_dataset_id: str, payload: TestDatasetUpdate) -> TestDataset:
    dataset = get_test_dataset(session, test_dataset_id)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes:
        name = str(changes["name"]).strip()
        if not name:
            raise ValidationError("test_dataset_name_blank", "Test dataset name cannot be blank.")
        dataset.name = name
    for field in ("version", "purpose_tag", "ftp_dir", "notes"):
        if field in changes:
            setattr(dataset, field, changes[field])
    session.commit()
    session.refresh(dataset)
    return dataset


def delete_test_dataset(session: Session, storage: Storage, test_dataset_id: str) -> None:
    dataset = get_test_dataset(session, test_dataset_id)
    if dataset.status == "locked":
        raise ConflictError("test_dataset_locked", "A test task is running on this dataset; deletion is blocked.")
    session.delete(dataset)
    session.commit()
    storage.remove_test_dataset(test_dataset_id)


def refresh_test_dataset_counts(session: Session, test_dataset_id: str, *, commit: bool = False) -> None:
    dataset = get_test_dataset(session, test_dataset_id)
    dataset.image_count = session.scalar(
        select(func.count()).select_from(TestImage).where(TestImage.test_dataset_id == test_dataset_id)
    ) or 0
    dataset.class_count = session.scalar(
        select(func.count()).select_from(TestClassLabel).where(TestClassLabel.test_dataset_id == test_dataset_id)
    ) or 0
    dataset.marked_count = session.scalar(
        select(func.count()).select_from(TestImage).where(TestImage.test_dataset_id == test_dataset_id, TestImage.status == "marked")
    ) or 0
    if commit:
        session.commit()


# ---------------------------------------------------------------------------
# 测试类别库
# ---------------------------------------------------------------------------


def list_test_classes(session: Session, test_dataset_id: str) -> list[TestClassLabel]:
    get_test_dataset(session, test_dataset_id)
    query = select(TestClassLabel).where(TestClassLabel.test_dataset_id == test_dataset_id).order_by(TestClassLabel.class_index)
    return list(session.scalars(query))


def create_test_class(session: Session, test_dataset_id: str, name: str, color: str) -> TestClassLabel:
    require_editable(session, test_dataset_id)
    next_index = session.scalar(
        select(func.max(TestClassLabel.class_index)).where(TestClassLabel.test_dataset_id == test_dataset_id)
    )
    class_label = TestClassLabel(
        id=new_id("tcls"),
        test_dataset_id=test_dataset_id,
        class_index=(next_index + 1) if next_index is not None else 0,
        name=name,
        color=color,
    )
    session.add(class_label)
    try:
        session.flush()
        refresh_test_dataset_counts(session, test_dataset_id)
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError("test_class_name_exists", "A class with this name already exists.") from exc
    session.refresh(class_label)
    return class_label


def import_templates_into_test_dataset(session: Session, test_dataset_id: str, template_ids: list[str]) -> tuple[list[TestClassLabel], list[str]]:
    """从全局类别模板库导入测试类别;同名跳过,返回 (导入类别, 跳过名称)。"""

    require_editable(session, test_dataset_id)
    get_test_dataset(session, test_dataset_id)
    existing = set(session.scalars(select(TestClassLabel.name).where(TestClassLabel.test_dataset_id == test_dataset_id)))
    imported: list[TestClassLabel] = []
    skipped: list[str] = []
    next_index = session.scalar(
        select(func.max(TestClassLabel.class_index)).where(TestClassLabel.test_dataset_id == test_dataset_id)
    )
    if next_index is None:
        next_index = -1
    for template_id in template_ids:
        template = session.get(ClassTemplate, template_id)
        if template is None:
            raise NotFoundError("class_template_not_found", f"Class template {template_id} was not found.")
        if template.name in existing:
            skipped.append(template.name)
            continue
        next_index += 1
        imported.append(
            TestClassLabel(
                id=new_id("tcls"),
                test_dataset_id=test_dataset_id,
                class_index=next_index,
                name=template.name,
                color=template.color,
            )
        )
    if imported:
        session.add_all(imported)
        try:
            session.flush()
            refresh_test_dataset_counts(session, test_dataset_id)
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            raise ConflictError("test_class_name_exists", "A class with this name already exists.") from exc
    return imported, skipped


def delete_test_class(session: Session, test_dataset_id: str, class_id: str) -> None:
    from app.core.models import TestAnnotation

    require_editable(session, test_dataset_id)
    class_label = session.get(TestClassLabel, class_id)
    if class_label is None or class_label.test_dataset_id != test_dataset_id:
        raise NotFoundError("test_class_not_found", "Test class label was not found.")
    annotation_count = session.scalar(
        select(func.count()).select_from(TestAnnotation).where(TestAnnotation.test_class_id == class_id)
    ) or 0
    if annotation_count:
        raise ConflictError("test_class_in_use", "Delete annotations using this class before deleting it.")
    session.delete(class_label)
    session.flush()
    remaining = list(
        session.scalars(
            select(TestClassLabel).where(TestClassLabel.test_dataset_id == test_dataset_id).order_by(TestClassLabel.class_index)
        )
    )
    # 先挪到互不冲突的负数临时位再落最终序号,避免 UNIQUE 中间态冲突(与训练类别删除同套路)。
    for offset, item in enumerate(remaining):
        item.class_index = -1 - offset
    session.flush()
    for index, item in enumerate(remaining):
        item.class_index = index
    refresh_test_dataset_counts(session, test_dataset_id)
    session.commit()


# ---------------------------------------------------------------------------
# 测试图片
# ---------------------------------------------------------------------------


def get_test_image(session: Session, image_id: str) -> TestImage:
    image = session.get(TestImage, image_id)
    if image is None:
        raise NotFoundError("test_image_not_found", "Test image was not found.")
    return image


def get_test_image_in_dataset(session: Session, test_dataset_id: str, image_id: str) -> TestImage:
    image = get_test_image(session, image_id)
    if image.test_dataset_id != test_dataset_id:
        raise NotFoundError("test_image_not_found", "Test image was not found in this test dataset.")
    return image


def _ordered_before(created_at, image_id: str):
    return or_(
        TestImage.created_at < created_at,
        and_(TestImage.created_at == created_at, TestImage.id < image_id),
    )


def _ordered_after(created_at, image_id: str):
    return or_(
        TestImage.created_at > created_at,
        and_(TestImage.created_at == created_at, TestImage.id > image_id),
    )


def list_test_images_page(
    session: Session,
    test_dataset_id: str,
    *,
    offset: int = 0,
    limit: int = 200,
    status: str | None = None,
    anchor: str | None = None,
) -> tuple[list[TestImage], int, int]:
    """数据库分页的测试图片列表,返回 (当前页, 筛选后总数, 实际使用的 offset)。"""

    get_test_dataset(session, test_dataset_id)
    conditions: list = [TestImage.test_dataset_id == test_dataset_id]
    if status:
        conditions.append(TestImage.status == status)
    resolved = offset
    if anchor:
        target = session.get(TestImage, anchor)
        if target is not None and target.test_dataset_id == test_dataset_id:
            in_result = session.scalar(select(func.count()).select_from(TestImage).where(*conditions, TestImage.id == anchor))
            if in_result:
                index = session.scalar(select(func.count()).select_from(TestImage).where(*conditions, _ordered_before(target.created_at, target.id))) or 0
                resolved = (index // limit) * limit
    total = session.scalar(select(func.count()).select_from(TestImage).where(*conditions)) or 0
    query = (
        select(TestImage)
        .where(*conditions)
        .order_by(TestImage.created_at, TestImage.id)
        .offset(resolved)
        .limit(limit)
    )
    return list(session.scalars(query)), total, resolved


def get_test_image_neighbors(session: Session, test_dataset_id: str, image_id: str) -> dict:
    image = get_test_image_in_dataset(session, test_dataset_id, image_id)
    scope = TestImage.test_dataset_id == test_dataset_id
    before = _ordered_before(image.created_at, image.id)
    after = _ordered_after(image.created_at, image.id)
    index = session.scalar(select(func.count()).select_from(TestImage).where(scope, before)) or 0
    total = session.scalar(select(func.count()).select_from(TestImage).where(scope)) or 0
    previous = session.scalar(
        select(TestImage).where(scope, before).order_by(TestImage.created_at.desc(), TestImage.id.desc()).limit(1)
    )
    next_image = session.scalar(
        select(TestImage).where(scope, after).order_by(TestImage.created_at.asc(), TestImage.id.asc()).limit(1)
    )
    return {"previous": previous, "next": next_image, "index": index, "total": total}


def _md5_hex(content: bytes) -> str:
    return hashlib.md5(content, usedforsecurity=False).hexdigest()


def _stage_test_image(session: Session, storage: Storage, test_dataset_id: str, original_name: str, content: bytes) -> TestImage:
    image_id = new_id("timg")
    storage_name, width, height = storage.write_test_image(test_dataset_id, image_id, original_name, content, max_bytes=len(content))
    return TestImage(
        id=image_id,
        test_dataset_id=test_dataset_id,
        file_name=Path(original_name).name,
        storage_name=storage_name,
        width=width,
        height=height,
        size_bytes=len(content),
        status="unmarked",
    )


def add_uploaded_test_images(
    session: Session,
    storage: Storage,
    test_dataset_id: str,
    uploads: list[tuple[str, bytes]],
) -> tuple[list[TestImage], list[str]]:
    """上传测试图片,MD5 去重:同数据集内相同内容跳过,返回 (新图片, 重复文件名列表)。"""

    require_editable(session, test_dataset_id)
    existing_checksums: set[str] = set(
        session.scalars(
            select(TestImage.source_checksum).where(
                TestImage.test_dataset_id == test_dataset_id,
                TestImage.source_checksum.is_not(None),
            )
        )
    )
    staged: list[TestImage] = []
    duplicates: list[str] = []
    batch_seen: set[str] = set()
    try:
        for file_name, content in uploads:
            checksum = _md5_hex(content)
            if checksum in existing_checksums or checksum in batch_seen:
                duplicates.append(file_name)
                continue
            batch_seen.add(checksum)
            image = _stage_test_image(session, storage, test_dataset_id, file_name, content)
            image.source_checksum = checksum
            staged.append(image)
        session.add_all(staged)
        session.flush()
        refresh_test_dataset_counts(session, test_dataset_id)
        session.commit()
    except Exception:
        session.rollback()
        for image in staged:
            storage.test_image_path(test_dataset_id, image.storage_name).unlink(missing_ok=True)
        raise
    for image in staged:
        session.refresh(image)
    return staged, duplicates


def update_test_image(session: Session, test_dataset_id: str, image_id: str, point_id: str | None) -> TestImage:
    image = get_test_image_in_dataset(session, test_dataset_id, image_id)
    image.point_id = (point_id or "").strip() or None
    session.commit()
    session.refresh(image)
    return image


def delete_test_image(session: Session, storage: Storage, test_dataset_id: str, image_id: str) -> None:
    require_editable(session, test_dataset_id)
    image = get_test_image_in_dataset(session, test_dataset_id, image_id)
    path = storage.test_image_path(test_dataset_id, image.storage_name)
    session.delete(image)
    session.flush()
    refresh_test_dataset_counts(session, test_dataset_id)
    session.commit()
    path.unlink(missing_ok=True)
