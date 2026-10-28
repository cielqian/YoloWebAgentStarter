"""数据集压缩包的后台异步导入。

导入接口在 wait=false 时先创建占位数据集（import_state=importing）并立即返回，
后台线程负责：FTP 下载（按字节汇报进度）→ 解压导入 → 终态（completed/failed）。
进度写在 datasets 表的 import_progress 列上，前端轮询列表即可展示。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.models import Dataset
from app.core.schemas import DatasetCreate, SplitName
from app.dataset.exchange.yolo import YoloArchiveLimits, _tree_zip_bytes
from app.core.storage import Storage
from app.core.task_types import TaskType
from app.dataset.exchange.coco import import_coco
from app.dataset.exchange.yolo import import_dataset
from app.ftp.service import FtpService

logger = logging.getLogger("ywa")

_DOWNLOAD_PROGRESS_SPAN = (2.0, 80.0)
_IMPORT_PROGRESS = 90.0


def _import_limits(settings: Settings) -> "YoloArchiveLimits":
    return YoloArchiveLimits(
        max_members=settings.max_yolo_archive_members,
        max_member_bytes=settings.max_yolo_archive_member_bytes,
        max_total_uncompressed_bytes=settings.max_yolo_archive_uncompressed_bytes,
        max_compression_ratio=settings.max_yolo_archive_compression_ratio,
    )

# dataset_id → 取消标记；停止导入通过置位事件让下载/导入循环协作式退出。
_cancel_events: dict[str, threading.Event] = {}


def request_cancel(dataset_id: str) -> None:
    event = _cancel_events.get(dataset_id)
    if event is not None:
        event.set()


def _update(session_factory: sessionmaker[Session], dataset_id: str, *, require_status: tuple[str, ...] | None = None, **fields: Any) -> None:
    with session_factory() as session:
        dataset = session.get(Dataset, dataset_id)
        if dataset is None:
            return
        if require_status and dataset.import_state not in require_status:
            return
        for key, value in fields.items():
            setattr(dataset, key, value)
        session.commit()



def run_async_merge(
    session_factory: sessionmaker[Session],
    storage: Storage,
    dataset_id: str,
    content: bytes | None = None,
    *,
    settings: Settings | None = None,
    ftp_path: str | None = None,
    ftp_source: str = "zip",
) -> None:
    """后台把 YOLO 压缩包/目录合并进已有数据集；状态机 merging → (None|merge_failed|merge_stopped)。"""
    from app.dataset.exchange.yolo import merge_yolo_into_dataset

    cancel_event = threading.Event()
    _cancel_events[dataset_id] = cancel_event

    def job() -> None:
        try:
            payload = content
            if payload is None and ftp_path is not None and settings is not None:
                from app.api.routers.datasets import _ftp_yolo_payload
                from types import SimpleNamespace

                payload = _ftp_yolo_payload(settings, SimpleNamespace(path=ftp_path, source=ftp_source))
            if payload is None:
                raise ValidationError("merge_payload_missing", "缺少待合并数据。")

            # 进度由合并事务内部分段提交更新（SQLite 单写者，跨事务写同一行会死锁）
            with session_factory() as session:
                from app.core.models import Dataset as DatasetModel

                dataset = session.get(DatasetModel, dataset_id)
                if dataset is None:
                    return
                merge_yolo_into_dataset(
                    session, storage, dataset, payload,
                    should_cancel=cancel_event.is_set,
                )
            if cancel_event.is_set():
                _update(session_factory, dataset_id, import_state="merge_stopped", import_progress=0.0, import_message="合并已停止。")
            else:
                # 合并成功：数据集恢复正常可用状态，不留导入标记
                _update(session_factory, dataset_id, import_state=None, import_progress=0.0, import_message=None)
        except Exception as exc:  # noqa: BLE001 - 合并失败不能影响数据集可用性
            if cancel_event.is_set():
                _update(session_factory, dataset_id, import_state="merge_stopped", import_progress=0.0, import_message="合并已停止。")
            else:
                logger.warning("数据集 %s 合并 YOLO 压缩包失败：%s", dataset_id, exc)
                _update(session_factory, dataset_id, import_state="merge_failed", import_message=str(exc))
        finally:
            _cleanup_cancel(dataset_id)

    threading.Thread(target=job, daemon=True, name=f"dataset-merge-{dataset_id}").start()


def recover_interrupted_imports(session_factory: sessionmaker[Session]) -> None:
    """服务重启后清理中断的合并任务（线程已丢失）。"""
    from app.core.models import Dataset as DatasetModel

    with session_factory() as session:
        datasets = list(session.scalars(select(DatasetModel).where(DatasetModel.import_state == "merging")))
        for dataset in datasets:
            dataset.import_state = "merge_failed"
            dataset.import_message = "服务重启导致合并中断，请重新上传压缩包。"
        if datasets:
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
    ftp_source: str = "zip",
    content: bytes | None = None,
) -> None:
    """启动后台导入线程；只做调度，不阻塞、不抛错（失败落在数据集状态上）。"""

    cancel_event = threading.Event()
    _cancel_events[dataset_id] = cancel_event

    def job() -> None:
        create = DatasetCreate(name=name, description=description, task_type=task_type)
        limits = _import_limits(settings)
        try:
            payload = content
            if ftp_path is not None and payload is None:
                from types import SimpleNamespace

                if ftp_source == "zip":
                    def on_progress(received: int, total: int | None) -> None:
                        if cancel_event.is_set():
                            raise ValidationError("import_cancelled", "导入已停止。")
                        fraction = received / total if total else 0.0
                        percent = _DOWNLOAD_PROGRESS_SPAN[0] + (_DOWNLOAD_PROGRESS_SPAN[1] - _DOWNLOAD_PROGRESS_SPAN[0]) * fraction
                        _update(session_factory, dataset_id, import_progress=round(min(percent, _DOWNLOAD_PROGRESS_SPAN[1]), 1))

                    _update(session_factory, dataset_id, import_progress=_DOWNLOAD_PROGRESS_SPAN[0], import_message="正在从 FTP 下载压缩包…")
                    _, payload = FtpService(settings).download_with_progress(ftp_path, on_progress)
                else:
                    from app.api.routers.datasets import _ftp_yolo_payload

                    _update(session_factory, dataset_id, import_progress=_DOWNLOAD_PROGRESS_SPAN[0], import_message="正在从 FTP 采集目录…")

                    def tree_progress(done: int, skipped: int) -> None:
                        _update(session_factory, dataset_id, import_progress=round(_DOWNLOAD_PROGRESS_SPAN[1] * min(done / max(settings.max_yolo_archive_members, 1), 1.0), 1))

                    tree, truncated, _skipped = FtpService(settings).fetch_yolo_tree(
                        ftp_path,
                        recursive=True,
                        max_bytes=settings.max_yolo_archive_member_bytes,
                        max_files=settings.max_yolo_archive_members,
                        on_progress=tree_progress,
                    )
                    if truncated:
                        raise ValidationError("ftp_dir_too_many_files", f"目录文件数超过 {settings.max_yolo_archive_members} 上限。")
                    payload = _tree_zip_bytes(tree, limits)
                if len(payload) > settings.max_upload_bytes:
                    raise ValidationError("upload_too_large", f"FTP 数据超过 {settings.max_upload_bytes // (1024 * 1024)} MB 导入上限。")

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
