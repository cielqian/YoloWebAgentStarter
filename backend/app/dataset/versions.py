from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError
from app.core.ids import new_id
from app.core.models import Annotation, ClassLabel, Dataset, DatasetVersion, ImageItem
from app.core.storage import Storage
from app.dataset.service import get_dataset, refresh_dataset_counts

_SNAPSHOT_SCHEMA = 1

_IMAGE_FIELDS = (
    "id",
    "file_name",
    "storage_name",
    "width",
    "height",
    "split",
    "status",
    "source_type",
    "source_file",
    "source_group_id",
    "source_video_task_id",
    "source_checksum",
    "frame_index",
    "timestamp",
)


def list_versions(session: Session, dataset_id: str) -> list[DatasetVersion]:
    get_dataset(session, dataset_id)
    return list(
        session.scalars(
            select(DatasetVersion)
            .where(DatasetVersion.dataset_id == dataset_id)
            .order_by(DatasetVersion.version_number.desc())
        )
    )


def workspace_counts(session: Session, dataset_id: str) -> tuple[int, int, int]:
    images = session.scalar(select(func.count()).select_from(ImageItem).where(ImageItem.dataset_id == dataset_id))
    annotations = session.scalar(select(func.count()).select_from(Annotation).where(Annotation.dataset_id == dataset_id))
    classes = session.scalar(select(func.count()).select_from(ClassLabel).where(ClassLabel.dataset_id == dataset_id))
    return images or 0, annotations or 0, classes or 0


def ensure_editable(session: Session, dataset_id: str) -> None:
    """激活历史版本时工作区只读；新建版本或激活最新版本后恢复可写。"""
    active = session.scalar(
        select(DatasetVersion).where(
            DatasetVersion.dataset_id == dataset_id, DatasetVersion.is_active.is_(True)
        )
    )
    if active is None:
        return
    latest = session.scalar(
        select(func.max(DatasetVersion.version_number)).where(DatasetVersion.dataset_id == dataset_id)
    )
    if latest is not None and active.version_number != latest:
        raise ConflictError(
            "dataset_read_only",
            f"当前激活的是历史版本 {active.version_label}（最新为 v{latest}），数据集只读。请新建版本或激活最新版本后再编辑。",
        )


def get_version_by_number(session: Session, dataset_id: str, version_number: int) -> DatasetVersion:
    version = session.scalar(
        select(DatasetVersion).where(
            DatasetVersion.dataset_id == dataset_id, DatasetVersion.version_number == version_number
        )
    )
    if version is None:
        raise NotFoundError("dataset_version_not_found", f"数据集版本 v{version_number} 不存在。")
    return version


def load_version_payload(storage: Storage, dataset_id: str, version: DatasetVersion) -> dict[str, Any]:
    path = storage.version_snapshot_path(dataset_id, version.id)
    if not path.is_file():
        raise NotFoundError("dataset_version_snapshot_missing", "版本快照文件缺失，无法按该版本导出。")
    return _read_snapshot(path)


def get_version(session: Session, dataset_id: str, version_id: str) -> DatasetVersion:
    version = session.get(DatasetVersion, version_id)
    if version is None or version.dataset_id != dataset_id:
        raise NotFoundError("dataset_version_not_found", "数据集版本不存在。")
    return version


def _workspace_payload(session: Session, dataset_id: str) -> dict[str, Any]:
    classes = list(
        session.scalars(
            select(ClassLabel).where(ClassLabel.dataset_id == dataset_id).order_by(ClassLabel.class_index)
        )
    )
    images = list(session.scalars(select(ImageItem).where(ImageItem.dataset_id == dataset_id).order_by(ImageItem.id)))
    annotations = list(session.scalars(select(Annotation).where(Annotation.dataset_id == dataset_id)))

    annotations_by_image: dict[str, list[dict[str, Any]]] = {}
    for item in annotations:
        annotations_by_image.setdefault(item.image_id, []).append(
            {
                "id": item.id,
                "class_id": item.class_id,
                "type": item.type,
                "x": item.x,
                "y": item.y,
                "width": item.width,
                "height": item.height,
                "polygon": item.polygon,
                "obb": item.obb,
                "keypoints": item.keypoints,
                "source": item.source,
            }
        )
    return {
        "schema": _SNAPSHOT_SCHEMA,
        "classes": [
            {
                "id": item.id,
                "class_index": item.class_index,
                "name": item.name,
                "color": item.color,
                "sam3_prompt": item.sam3_prompt,
            }
            for item in classes
        ],
        "images": [
            {
                **{field: getattr(item, field) for field in _IMAGE_FIELDS},
                "annotations": annotations_by_image.get(item.id, []),
            }
            for item in images
        ],
    }


def _label_taken(session: Session, dataset_id: str, label: str) -> bool:
    """同数据集内标签唯一(忽略大小写,避免 v1 与 V1 共存)。"""
    return (
        session.scalar(
            select(func.count())
            .select_from(DatasetVersion)
            .where(
                DatasetVersion.dataset_id == dataset_id,
                func.lower(DatasetVersion.version_label) == label.lower(),
            )
        )
        or 0
    ) > 0


def _unique_label(session: Session, dataset_id: str, base: str) -> str:
    """默认标签被占用时追加 _2/_3…,保证自动新建版本永不因重名失败。"""
    if not _label_taken(session, dataset_id, base):
        return base
    suffix = 2
    while _label_taken(session, dataset_id, f"{base}_{suffix}"):
        suffix += 1
    return f"{base}_{suffix}"


def create_version(
    session: Session,
    storage: Storage,
    dataset_id: str,
    note: str | None,
    version_label: str | None = None,
) -> DatasetVersion:
    get_dataset(session, dataset_id)
    payload = _workspace_payload(session, dataset_id)
    image_count, annotation_count, class_count = workspace_counts(session, dataset_id)

    last_number = session.scalar(
        select(func.max(DatasetVersion.version_number)).where(DatasetVersion.dataset_id == dataset_id)
    )
    number = (last_number or 0) + 1
    label = (version_label or "").strip()
    if not label:
        label = _unique_label(session, dataset_id, f"v{number}")
    elif _label_taken(session, dataset_id, label):
        raise ConflictError("dataset_version_label_taken", f"版本号“{label}”已存在，请换一个。")
    version = DatasetVersion(
        id=new_id("dsv"),
        dataset_id=dataset_id,
        version_number=number,
        version_label=label,
        note=note,
        is_active=True,
        image_count=image_count,
        annotation_count=annotation_count,
        class_count=class_count,
    )
    path = storage.version_snapshot_path(dataset_id, version.id)
    _write_snapshot(path, payload)
    session.execute(
        update(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id).values(is_active=False)
    )
    session.add(version)
    try:
        session.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    session.refresh(version)
    return version


def activate_version(
    session: Session, storage: Storage, dataset_id: str, version_id: str
) -> tuple[DatasetVersion, int, int]:
    """Rewrite the live workspace (classes/images/annotations) from a snapshot.

    Snapshot images whose files were later deleted from disk are skipped
    together with their annotations. Current workspace files are never removed,
    so other versions that still reference them stay restorable.
    """

    version = get_version(session, dataset_id, version_id)
    path = storage.version_snapshot_path(dataset_id, version.id)
    if not path.is_file():
        raise NotFoundError("dataset_version_snapshot_missing", "版本快照文件缺失，无法恢复。")
    payload = _read_snapshot(path)

    session.execute(delete(Annotation).where(Annotation.dataset_id == dataset_id))
    session.execute(delete(ImageItem).where(ImageItem.dataset_id == dataset_id))
    session.execute(delete(ClassLabel).where(ClassLabel.dataset_id == dataset_id))

    session.add_all(
        ClassLabel(
            id=item["id"],
            dataset_id=dataset_id,
            class_index=item["class_index"],
            name=item["name"],
            color=item["color"],
            sam3_prompt=item.get("sam3_prompt"),
        )
        for item in payload["classes"]
    )
    restored = 0
    skipped = 0
    for item in payload["images"]:
        if not storage.image_path(dataset_id, item["storage_name"]).is_file():
            skipped += 1
            continue
        session.add(
            ImageItem(
                **{field: item.get(field) for field in _IMAGE_FIELDS},
                dataset_id=dataset_id,
            )
        )
        restored += 1
        for annotation in item.get("annotations", []):
            session.add(
                Annotation(
                    id=annotation["id"],
                    image_id=item["id"],
                    dataset_id=dataset_id,
                    class_id=annotation["class_id"],
                    type=annotation["type"],
                    x=annotation.get("x"),
                    y=annotation.get("y"),
                    width=annotation.get("width"),
                    height=annotation.get("height"),
                    polygon=annotation.get("polygon"),
                    obb=annotation.get("obb"),
                    keypoints=annotation.get("keypoints"),
                    source=annotation.get("source") or "manual",
                )
            )
    session.execute(
        update(DatasetVersion).where(DatasetVersion.dataset_id == dataset_id).values(is_active=False)
    )
    version.is_active = True
    refresh_dataset_counts(session, dataset_id)
    session.commit()
    session.refresh(version)
    return version, restored, skipped


def clone_version(
    session: Session,
    storage: Storage,
    dataset_id: str,
    version_id: str | None,
    name: str,
    description: str | None = None,
) -> tuple[Dataset, int, int, int]:
    """Materialize a version snapshot as a brand-new dataset.

    Passing version_id=None clones the current live workspace instead, so
    datasets that never archived a version are still cloneable. Image files
    are copied into the new dataset's directory so the clone stays usable
    after the source dataset is deleted; rows get fresh ids and the clone
    starts with no version history of its own.
    """

    source = get_dataset(session, dataset_id)
    if version_id is None:
        payload = _workspace_payload(session, dataset_id)
    else:
        version = get_version(session, dataset_id, version_id)
        path = storage.version_snapshot_path(dataset_id, version_id)
        if not path.is_file():
            raise NotFoundError("dataset_version_snapshot_missing", "版本快照文件缺失，无法克隆。")
        payload = _read_snapshot(path)

    target = Dataset(id=new_id("ds"), name=name, model_name=source.model_name, description=description, task_type=source.task_type, pose_config_json=source.pose_config_json)
    session.add(target)

    class_ids = {item["id"]: new_id("cls") for item in payload["classes"]}
    for item in payload["classes"]:
        session.add(
            ClassLabel(
                id=class_ids[item["id"]],
                dataset_id=target.id,
                class_index=item["class_index"],
                name=item["name"],
                color=item["color"],
                sam3_prompt=item.get("sam3_prompt"),
            )
        )

    imported = 0
    skipped = 0
    annotation_total = 0
    for item in payload["images"]:
        source_path = storage.image_path(dataset_id, item["storage_name"])
        if not source_path.is_file():
            skipped += 1
            continue
        values = {field: item.get(field) for field in _IMAGE_FIELDS}
        image_id = new_id("img")
        values["id"] = image_id
        shutil.copyfile(source_path, storage.image_path(target.id, item["storage_name"]))
        session.add(ImageItem(**values, dataset_id=target.id))
        imported += 1
        for annotation in item.get("annotations", []):
            session.add(
                Annotation(
                    id=new_id("ann"),
                    image_id=image_id,
                    dataset_id=target.id,
                    class_id=class_ids[annotation["class_id"]],
                    type=annotation["type"],
                    x=annotation.get("x"),
                    y=annotation.get("y"),
                    width=annotation.get("width"),
                    height=annotation.get("height"),
                    polygon=annotation.get("polygon"),
                    obb=annotation.get("obb"),
                    keypoints=annotation.get("keypoints"),
                    source=annotation.get("source") or "manual",
                )
            )
            annotation_total += 1
    refresh_dataset_counts(session, target.id)
    session.commit()
    session.refresh(target)
    return target, imported, annotation_total, skipped


def rename_version(session: Session, dataset_id: str, version_id: str, version_label: str) -> DatasetVersion:
    """手动维护版本号文本;数据集内唯一(忽略大小写)。"""
    version = get_version(session, dataset_id, version_id)
    label = version_label.strip()
    if not label:
        raise ConflictError("dataset_version_label_invalid", "版本号不能为空。")
    if label.lower() != version.version_label.lower() and _label_taken(session, dataset_id, label):
        raise ConflictError("dataset_version_label_taken", f"版本号“{label}”已存在，请换一个。")
    version.version_label = label
    session.commit()
    session.refresh(version)
    return version


def delete_version(session: Session, storage: Storage, dataset_id: str, version_id: str) -> None:
    version = get_version(session, dataset_id, version_id)
    if version.is_active:
        raise ConflictError("dataset_version_active", "无法删除正在激活的版本，请先激活其他版本。")
    path = storage.version_snapshot_path(dataset_id, version_id)
    session.delete(version)
    session.commit()
    path.unlink(missing_ok=True)


def _write_snapshot(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(path)


def _read_snapshot(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        raise NotFoundError("dataset_version_snapshot_missing", f"版本快照文件无法读取: {exc}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("schema") != _SNAPSHOT_SCHEMA
        or not isinstance(payload.get("classes"), list)
        or not isinstance(payload.get("images"), list)
    ):
        raise NotFoundError("dataset_version_snapshot_invalid", "版本快照格式不正确。")
    return payload
