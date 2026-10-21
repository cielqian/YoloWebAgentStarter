"""数据集压缩包的后台异步导入。

导入接口在 wait=false 时先创建占位数据集（import_state=importing）并立即返回，
后台线程负责：FTP 下载（按字节汇报进度）→ 解压导入 → 终态（completed/failed）。
进度写在 datasets 表的 import_progress 列上，前端轮询列表即可展示。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.models import Dataset
from app.core.schemas import DatasetCreate, SplitName
from app.dataset.exchange.yolo import YoloArchiveLimits
from app.core.storage import Storage
from app.core.task_types import TaskType
from app.dataset.exchange.coco import import_coco
from app.dataset.exchange.yolo import import_dataset
from app.ftp.service import FtpService

logger = logging.getLogger("ywa")

_DOWNLOAD_PROGRESS_SPAN = (2.0, 80.0)
_IMPORT_PROGRESS = 90.0

# dataset_id → 取消标记；停止导入通过置位事件让下载/导入循环协作式退出。
_cancel_events: dict[str, threading.Event] = {}


def request_cancel(dataset_id: str) -> None:
    event = _cancel_events.get(dataset_id)
    if event is not None:
        event.set()


def _update(session_factory: sessionmaker[Session], dataset_id: str, **fields: Any) -> None:
    with session_factory() as session:
        dataset = session.get(Dataset, dataset_id)
        if dataset is None:
            return
        for key, value in fields.items():
            setattr(dataset, key, value)
        session.commit()


def _cleanup_cancel(dataset_id: str) -> None:
    _cancel_events.pop(dataset_id, None)


def run_async_import(
    session_factory: sessionmaker[Session],
    storage: Storage,
    settings: Settings,
    *,
    dataset_id: str,
    name: str,
    task_type: TaskType,
    description: str | None,
    default_split: SplitName,
    archive_format: str,
    ftp_path: str | None = None,
    content: bytes | None = None,
) -> None:
    """启动后台导入线程；只做调度，不阻塞、不抛错（失败落在数据集状态上）。"""

    cancel_event = threading.Event()
    _cancel_events[dataset_id] = cancel_event

    def job() -> None:
        create = DatasetCreate(name=name, description=description, task_type=task_type)
        limits = YoloArchiveLimits(
            max_members=settings.max_yolo_archive_members,
            max_member_bytes=settings.max_yolo_archive_member_bytes,
            max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
            max_compression_ratio=settings.max_yolo_archive_compression_ratio,
        )
        try:
            payload = content
            if ftp_path is not None and payload is None:
                def on_progress(received: int, total: int | None) -> None:
                    if cancel_event.is_set():
                        raise ValidationError("import_cancelled", "导入已停止。")
                    fraction = received / total if total else 0.0
                    percent = _DOWNLOAD_PROGRESS_SPAN[0] + (_DOWNLOAD_PROGRESS_SPAN[1] - _DOWNLOAD_PROGRESS_SPAN[0]) * fraction
                    _update(session_factory, dataset_id, import_progress=round(min(percent, _DOWNLOAD_PROGRESS_SPAN[1]), 1))

                _update(session_factory, dataset_id, import_progress=_DOWNLOAD_PROGRESS_SPAN[0], import_message="正在从 FTP 下载压缩包…")
                _, payload = FtpService(settings).download_with_progress(ftp_path, on_progress)
                if len(payload) > settings.max_upload_bytes:
                    raise ValidationError("upload_too_large", f"FTP 文件超过 {settings.max_upload_bytes // (1024 * 1024)} MB 导入上限。")

            _update(session_factory, dataset_id, import_progress=_IMPORT_PROGRESS, import_message="正在解压并导入…")
            with session_factory() as session:
                if archive_format == "coco":
                    import_coco(session, storage, payload, create, limits=limits, dataset_id=dataset_id, should_cancel=cancel_event.is_set)
                else:
                    import_dataset(
                        session, storage, payload, create,
                        default_split=default_split,  # type: ignore[arg-type]
                        limits=limits,
                        dataset_id=dataset_id,
                        should_cancel=cancel_event.is_set,
                    )
                session.commit()
            if cancel_event.is_set():
                _update(session_factory, dataset_id, import_state="stopped", import_progress=0.0, import_message="导入已停止。")
            else:
                _update(session_factory, dataset_id, import_state="completed", import_progress=100.0, import_message=None)
        except Exception as exc:  # noqa: BLE001 - 失败必须落到数据集状态而不是线程崩溃
            if cancel_event.is_set():
                _update(session_factory, dataset_id, import_state="stopped", import_progress=0.0, import_message="导入已停止。")
            else:
                logger.warning("异步导入数据集 %s 失败：%s", dataset_id, exc)
                _update(session_factory, dataset_id, import_state="failed", import_message=str(exc))
        finally:
            _cleanup_cancel(dataset_id)

    threading.Thread(target=job, daemon=True, name=f"dataset-import-{dataset_id}").start()
