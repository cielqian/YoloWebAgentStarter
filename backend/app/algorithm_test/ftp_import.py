"""测试数据集的 FTP 异步建集。

与训练数据集的 import_runner 同一套模式:接口先创建占位数据集(import_state=importing)
立即返回,后台线程负责 FTP 下载 → 解压解析 YOLO 结构 → 写入 test_* 表 → 终态。
zip 内解析复用 exchange.yolo 的解析器;YOLO labels 会作为预期结果标注一并导入。
"""

from __future__ import annotations

import hashlib
import logging
import threading
from pathlib import Path, PurePosixPath
from typing import Callable
from zipfile import BadZipFile

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.ids import new_id
from app.core.models import TestAnnotation, TestClassLabel, TestDataset, TestImage
from app.core.storage import Storage
from app.dataset.exchange.yolo import (
    SUPPORTED_IMAGE_SUFFIXES,
    YoloArchiveLimits,
    _archive_entries,
    _class_for_image,
    _label_for_image,
    _names_from_yaml,
    _parse_yolo_labels,
    _read_archive_member,
    _relative_key,
)

logger = logging.getLogger("ywa")

_MAX_LABEL_BYTES = 4 * 1024 * 1024
_DOWNLOAD_PROGRESS_SPAN = (2.0, 80.0)
_IMPORT_PROGRESS = 90.0

# dataset_id → 取消标记
_cancel_events: dict[str, threading.Event] = {}


def request_cancel(test_dataset_id: str) -> None:
    event = _cancel_events.get(test_dataset_id)
    if event is not None:
        event.set()


def _cleanup_cancel(test_dataset_id: str) -> None:
    _cancel_events.pop(test_dataset_id, None)


def _update(session_factory: sessionmaker[Session], test_dataset_id: str, **fields: object) -> None:
    with session_factory() as session:
        dataset = session.get(TestDataset, test_dataset_id)
        if dataset is None:
            return
        for key, value in fields.items():
            setattr(dataset, key, value)
        session.commit()


def _md5_hex(content: bytes) -> str:
    return hashlib.md5(content, usedforsecurity=False).hexdigest()


def import_yolo_into_test_dataset(
    session: Session,
    storage: Storage,
    dataset: TestDataset,
    payload: bytes,
    limits: YoloArchiveLimits,
    should_cancel: Callable[[], bool] | None = None,
) -> tuple[int, int]:
    """把 YOLO zip 写入测试数据集;labels 作为预期标注导入。返回 (图片数, 标注数)。

    与训练导入的差别:无 split 概念;有标注的图片直接 marked;MD5 去重跳过已存在内容。
    """

    archive, entries = _archive_entries(payload, limits)
    staged: list[tuple[str, str]] = []
    try:
        image_entries = {
            name: info
            for name, info in entries.items()
            if PurePosixPath(name).suffix.lower() in SUPPORTED_IMAGE_SUFFIXES
        }
        if not image_entries:
            raise ValidationError("no_images_in_archive", "压缩包/目录中未找到受支持的图片文件。")
        labels = {
            _relative_key(name, "labels"): info
            for name, info in entries.items()
            if PurePosixPath(name).suffix.lower() == ".txt"
            and ("labels" in PurePosixPath(name).parts or PurePosixPath(name).name != "classes.txt")
        }
        if dataset.task_type == "classify":
            classification_classes = {_class_for_image(member_name) for member_name in image_entries}
            if None in classification_classes:
                raise ValidationError("invalid_classification_layout", "分类目录必须是 train|val|test/<类别名>/<图片> 的布局。")
            names = sorted(str(name) for name in classification_classes)
        else:
            names = _names_from_yaml(archive, entries)
            if not names:
                max_class_index = -1
                for info in labels.values():
                    for line in _read_archive_member(archive, info, _MAX_LABEL_BYTES).decode("utf-8", errors="ignore").splitlines():
                        if line.strip():
                            try:
                                max_class_index = max(max_class_index, int(line.split()[0]))
                            except (ValueError, IndexError):
                                pass
                names = [f"class_{index}" for index in range(max_class_index + 1)]
            # 纯图片包(无 yaml 无 label)允许建集:预期标注与类别随后在线补。

        class_records = [
            TestClassLabel(id=new_id("tcls"), test_dataset_id=dataset.id, class_index=index, name=name, color="#22c55e")
            for index, name in enumerate(names)
        ]
        session.add_all(class_records)
        class_id_by_index = {item.class_index: item.id for item in class_records}
        class_id_by_name = {item.name: item.id for item in class_records}

        existing_checksums = set(
            session.scalars(
                select(TestImage.source_checksum).where(
                    TestImage.test_dataset_id == dataset.id,
                    TestImage.source_checksum.is_not(None),
                )
            )
        )
        imported_images = 0
        imported_annotations = 0
        session.flush()
        for member_name, info in sorted(image_entries.items()):
            if should_cancel is not None and should_cancel():
                raise ValidationError("import_cancelled", "导入已停止。")
            content = _read_archive_member(archive, info, limits.max_member_bytes)
            checksum = _md5_hex(content)
            if checksum in existing_checksums:
                continue
            existing_checksums.add(checksum)
            image_id = new_id("timg")
            storage_name, width, height = storage.write_test_image(
                dataset.id, image_id, PurePosixPath(member_name).name, content, max_bytes=limits.max_member_bytes
            )
            staged.append((dataset.id, storage_name))
            image = TestImage(
                id=image_id,
                test_dataset_id=dataset.id,
                file_name=PurePosixPath(member_name).name,
                storage_name=storage_name,
                width=width,
                height=height,
                size_bytes=len(content),
                status="unmarked",
                source_checksum=checksum,
            )
            session.add(image)
            session.flush()
            if dataset.task_type == "classify":
                class_id = class_id_by_name.get(_class_for_image(member_name) or "")
                if class_id is None:
                    raise ValidationError("invalid_classification_layout", "图片的类别目录未在压缩包中定义。")
                parsed_annotations = _classify_annotation(class_id)
            else:
                label_info = _label_for_image(member_name, labels)
                label = _read_archive_member(archive, label_info, _MAX_LABEL_BYTES) if label_info else None
                parsed_annotations = _parse_yolo_labels(
                    label,
                    dataset.task_type,
                    width,
                    height,
                    class_id_by_index,  # type: ignore[arg-type]
                    source_name=PurePosixPath(member_name).name,
                )
            for sort_order, item in enumerate(parsed_annotations):
                session.add(
                    TestAnnotation(
                        id=new_id("tann"),
                        test_image_id=image.id,
                        test_dataset_id=dataset.id,
                        test_class_id=item.class_id,
                        type=item.type,
                        x=item.x,
                        y=item.y,
                        width=item.width,
                        height=item.height,
                        polygon=item.polygon,
                        obb=item.obb,
                        difficult=False,
                        source="imported",
                        sort_order=sort_order,
                    )
                )
                imported_annotations += 1
            if parsed_annotations:
                image.status = "marked"
            imported_images += 1
        from app.algorithm_test.datasets import refresh_test_dataset_counts

        refresh_test_dataset_counts(session, dataset.id)
        dataset.import_state = "completed"
        dataset.import_progress = 100.0
        dataset.import_message = None
        session.commit()
        return imported_images, imported_annotations
    except Exception:
        session.rollback()
        for dataset_id, storage_name in staged:
            storage.test_image_path(dataset_id, storage_name).unlink(missing_ok=True)
        raise
    finally:
        archive.close()


def _classify_annotation(class_id: str) -> list:
    from app.core.models import Annotation

    return [Annotation(id=new_id("ann"), class_id=class_id, type="classify", source="imported")]


def run_async_test_import(
    session_factory: sessionmaker[Session],
    storage: Storage,
    settings: Settings,
    *,
    test_dataset_id: str,
    ftp_path: str,
    ftp_source: str,
) -> None:
    """启动后台建集线程;只做调度,失败落在数据集 import_state 上。"""

    cancel_event = threading.Event()
    _cancel_events[test_dataset_id] = cancel_event

    def job() -> None:
        staged: list[tuple[str, str]] = []
        try:
            from app.api.routers.datasets import _ftp_yolo_payload
            from types import SimpleNamespace

            if ftp_source == "zip":
                def on_progress(received: int, total: int | None) -> None:
                    if cancel_event.is_set():
                        raise ValidationError("import_cancelled", "导入已停止。")
                    fraction = received / total if total else 0.0
                    percent = _DOWNLOAD_PROGRESS_SPAN[0] + (_DOWNLOAD_PROGRESS_SPAN[1] - _DOWNLOAD_PROGRESS_SPAN[0]) * fraction
                    _update(session_factory, test_dataset_id, import_progress=round(min(percent, _DOWNLOAD_PROGRESS_SPAN[1]), 1))

                _update(session_factory, test_dataset_id, import_progress=_DOWNLOAD_PROGRESS_SPAN[0], import_message="正在从 FTP 下载压缩包…")
            else:
                _update(session_factory, test_dataset_id, import_progress=_DOWNLOAD_PROGRESS_SPAN[0], import_message="正在从 FTP 采集目录…")

            payload = _ftp_yolo_payload(settings, SimpleNamespace(path=ftp_path, source=ftp_source))
            if len(payload) > settings.max_upload_bytes:
                raise ValidationError("upload_too_large", f"FTP 数据超过 {settings.max_upload_bytes // (1024 * 1024)} MB 导入上限。")

            _update(session_factory, test_dataset_id, import_progress=_IMPORT_PROGRESS, import_message="正在解压并导入…")
            limits = YoloArchiveLimits(
                max_members=settings.max_yolo_archive_members,
                max_member_bytes=settings.max_yolo_archive_member_bytes,
                max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
                max_compression_ratio=settings.max_yolo_archive_compression_ratio,
            )
            with session_factory() as session:
                dataset = session.get(TestDataset, test_dataset_id)
                if dataset is None:
                    return
                import_yolo_into_test_dataset(session, storage, dataset, payload, limits, should_cancel=cancel_event.is_set)
        except Exception as exc:  # noqa: BLE001 - 失败必须落到状态而不是线程崩溃
            if cancel_event.is_set():
                _update(session_factory, test_dataset_id, import_state="stopped", import_progress=0.0, import_message="导入已停止。")
            else:
                logger.warning("测试数据集 %s FTP 建集失败：%s", test_dataset_id, exc)
                _update(session_factory, test_dataset_id, import_state="failed", import_message=str(exc))
        finally:
            _cleanup_cancel(test_dataset_id)

    threading.Thread(target=job, daemon=True, name=f"test-dataset-import-{test_dataset_id}").start()


def recover_interrupted_test_imports(session_factory: sessionmaker[Session]) -> None:
    """服务重启后清理中断的 FTP 建集(线程已丢失)。"""

    with session_factory() as session:
        datasets = list(session.scalars(select(TestDataset).where(TestDataset.import_state == "importing")))
        for dataset in datasets:
            dataset.import_state = "failed"
            dataset.import_message = "服务重启导致导入中断，请重新发起 FTP 同步。"
        if datasets:
            session.commit()
