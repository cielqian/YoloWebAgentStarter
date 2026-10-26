"""Remote training dispatch and state sync against compute-agent nodes.

Backend owns the TrainingTask row; the agent owns the actual subprocess. The
dispatch flow is: export the dataset to a zip, upload it plus optional base
weights, then start. A background poller mirrors agent status, progress, logs,
and final artifacts back into the managed training directory.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.models import TrainingTask
from app.core.storage import Storage
from app.core.time import utc_now
from app.settings.service import SettingsService
from app.training.observability.log_store import TrainingLogStore
from app.training.observability.metrics import TrainingMetricsParser
from app.training.observability.summary import write_training_summary
from app.training.runtime import remote_nodes
from app.training.runtime.remote_nodes import RemoteNodeUnavailable
from app.training.webhooks import notify_training_status

DISPATCH_TIMEOUT_SECONDS = 600.0
POLL_TIMEOUT_SECONDS = 10.0
POLL_INTERVAL_SECONDS = 5.0
UNREACHABLE_FAIL_AFTER_SECONDS = 600.0

TERMINAL_STATUSES = {"completed", "failed", "stopped"}


class RemoteTrainingError(Exception):
    """Dispatching a remote task failed; the task must not be created."""


def find_node(settings: Settings, node_id: str) -> dict[str, Any] | None:
    for node in SettingsService(settings).list_training_nodes():
        if node.get("id") == node_id:
            return node
    return None


def _base(node: dict[str, Any]) -> str:
    return str(node.get("url") or "").strip().rstrip("/")


def _headers(node: dict[str, Any]) -> dict[str, str]:
    token = str(node.get("token") or "").strip()
    return {"X-Agent-Token": token} if token else {}


def _detail(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return f"HTTP {response.status_code}" + (f"：{detail}" if detail else "")


def dispatch_remote_task(
    node: dict[str, Any],
    spec: dict[str, Any],
    dataset_zip: Path,
    weights: Path | None,
    on_progress: Any = None,
) -> None:
    task_id = str(spec["task_id"])
    base = _base(node)
    headers = _headers(node)
    try:
        with httpx.Client(timeout=DISPATCH_TIMEOUT_SECONDS) as client:
            response = client.post(f"{base}/tasks", json=spec, headers=headers)
            if response.status_code not in (201, 409):
                raise RemoteTrainingError(f"创建任务失败：{_detail(response)}")
            if on_progress is None:
                with dataset_zip.open("rb") as handle:
                    response = client.put(
                        f"{base}/tasks/{task_id}/dataset",
                        content=handle,
                        headers={**headers, "Content-Type": "application/zip"},
                    )
            else:
                # 大数据集按块上传并回调进度；生成器内抛出的取消异常会中断请求。
                total = dataset_zip.stat().st_size
                sent = 0

                def chunks():
                    nonlocal sent
                    with dataset_zip.open("rb") as handle:
                        while True:
                            block = handle.read(1024 * 1024)
                            if not block:
                                break
                            sent += len(block)
                            on_progress(sent, total)
                            yield block

                response = client.put(
                    f"{base}/tasks/{task_id}/dataset",
                    content=chunks(),
                    headers={**headers, "Content-Type": "application/zip", "Content-Length": str(total)},
                )
            if response.status_code != 200:
                raise RemoteTrainingError(f"上传数据集失败：{_detail(response)}")
            if weights is not None and weights.is_file():
                with weights.open("rb") as handle:
                    response = client.put(
                        f"{base}/tasks/{task_id}/weights",
                        params={"name": weights.name},
                        content=handle,
                        headers=headers,
                    )
                if response.status_code != 200:
                    raise RemoteTrainingError(f"上传基础权重失败：{_detail(response)}")
            response = client.post(f"{base}/tasks/{task_id}/start", headers=headers)
            if response.status_code != 200:
                raise RemoteTrainingError(f"启动训练失败：{_detail(response)}")
    except httpx.HTTPError as exc:
        raise RemoteTrainingError(f"连接训练节点失败：{exc.__class__.__name__}") from exc
    except RemoteTrainingError:
        delete_remote_task(node, task_id)
        raise


def fetch_task_status(node: dict[str, Any], task_id: str) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=POLL_TIMEOUT_SECONDS) as client:
            response = client.get(f"{_base(node)}/tasks/{task_id}", headers=_headers(node))
    except httpx.HTTPError as exc:
        raise RemoteNodeUnavailable(f"连接失败：{exc.__class__.__name__}") from exc
    if response.status_code == 404:
        raise RemoteNodeUnavailable(f"agent 上不存在任务 {task_id}。")
    if response.status_code == 401:
        raise RemoteNodeUnavailable("token 校验失败（401），请检查节点共享密钥。")
    if response.status_code != 200:
        raise RemoteNodeUnavailable(f"agent 返回 HTTP {response.status_code}。")
    try:
        payload = response.json()
        if not isinstance(payload.get("status"), str):
            raise TypeError("status is not a string")
    except (ValueError, TypeError) as exc:
        raise RemoteNodeUnavailable("agent 任务状态响应格式不正确。") from exc
    return payload


def fetch_task_logs(node: dict[str, Any], task_id: str, after: int = 0) -> dict[str, Any]:
    with httpx.Client(timeout=POLL_TIMEOUT_SECONDS) as client:
        response = client.get(f"{_base(node)}/tasks/{task_id}/logs", params={"after": after}, headers=_headers(node))
    if response.status_code != 200:
        raise RemoteNodeUnavailable(f"agent 返回 HTTP {response.status_code}。")
    payload = response.json()
    if not isinstance(payload, dict):
        raise RemoteNodeUnavailable("agent 日志响应格式不正确。")
    return payload


def download_artifact(node: dict[str, Any], task_id: str, name: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with httpx.Client(timeout=DISPATCH_TIMEOUT_SECONDS) as client:
            with client.stream("GET", f"{_base(node)}/tasks/{task_id}/artifacts/{name}", headers=_headers(node)) as response:
                if response.status_code != 200:
                    raise RemoteTrainingError(f"下载 {name} 失败：HTTP {response.status_code}")
                with destination.open("wb") as handle:
                    for chunk in response.iter_bytes(1024 * 1024):
                        handle.write(chunk)
    except httpx.HTTPError as exc:
        raise RemoteTrainingError(f"下载 {name} 失败：{exc.__class__.__name__}") from exc


def stop_remote_task(node: dict[str, Any], task_id: str) -> None:
    try:
        with httpx.Client(timeout=POLL_TIMEOUT_SECONDS) as client:
            client.post(f"{_base(node)}/tasks/{task_id}/stop", headers=_headers(node))
    except httpx.HTTPError:
        pass


def delete_remote_task(node: dict[str, Any], task_id: str) -> None:
    try:
        with httpx.Client(timeout=POLL_TIMEOUT_SECONDS) as client:
            client.delete(f"{_base(node)}/tasks/{task_id}", headers=_headers(node))
    except httpx.HTTPError:
        pass


def _mapped_metrics(raw: dict[str, Any]) -> dict[str, float]:
    parser = TrainingMetricsParser()
    row = {str(key): str(value) for key, value in raw.items() if isinstance(value, (int, float))}
    return parser._parse_row(row)


def _append_new_logs(node: dict[str, Any], task: TrainingTask) -> None:
    """增量镜像 agent 日志。

    偏移量用独立的 sidecar 计数文件维护：train.log 里还混有后端自己写入的
    下发/终态消息，若直接用本地行数当 after，会跳过 agent 日志的开头几行
    （恰是权重拉取记录）。
    """
    if not task.logs_path:
        return
    store = TrainingLogStore(task.logs_path)
    counter_path = Path(task.logs_path).with_suffix(".agent-count")
    mirrored = 0
    if counter_path.is_file():
        try:
            mirrored = int(counter_path.read_text(encoding="utf-8").strip() or 0)
        except ValueError:
            mirrored = 0
    payload = fetch_task_logs(node, task.id, after=mirrored)
    remote_count = int(payload.get("line_count") or 0)
    if remote_count < mirrored:
        # agent 侧任务被重建，从头镜像
        mirrored = 0
        payload = fetch_task_logs(node, task.id, after=0)
        remote_count = int(payload.get("line_count") or 0)
    new_logs = str(payload.get("logs") or "")
    if new_logs.strip():
        store.append(new_logs)
    if remote_count != mirrored:
        counter_path.write_text(str(remote_count), encoding="utf-8")


def sync_remote_task(session: Session, storage: Storage, settings: Settings, task: TrainingTask, unreachable_since: dict[str, float]) -> None:
    node = find_node(settings, task.node_id or "")
    if node is None:
        _finalize(session, task, "failed", "训练节点已被删除，远程训练无法继续。")
        return

    if task.stop_requested and task.status == "running":
        stop_remote_task(node, task.id)

    try:
        status = fetch_task_status(node, task.id)
        _append_new_logs(node, task)
    except RemoteNodeUnavailable as exc:
        first = unreachable_since.setdefault(task.id, time.monotonic())
        if time.monotonic() - first >= UNREACHABLE_FAIL_AFTER_SECONDS:
            unreachable_since.pop(task.id, None)
            _finalize(session, task, "failed", f"训练节点失联超过 10 分钟：{exc}")
        return
    unreachable_since.pop(task.id, None)

    remote_status = str(status.get("status") or "")
    progress = status.get("progress") or {}
    if isinstance(progress, dict):
        total = int(progress.get("total_epochs") or task.epochs or 1)
        epoch = min(int(progress.get("epoch") or 0), total)
        task.progress_total_epochs = max(total, 1)
        task.progress_epoch = max(epoch, task.progress_epoch if remote_status != "pending" else 0)
        task.progress_percent = round(task.progress_epoch / task.progress_total_epochs * 100, 2)
    live_metrics = dict(task.metrics_json or {})
    for key in ("batch_time_seconds", "speed_it_per_sec"):
        value = (progress or {}).get(key) if isinstance(progress, dict) else None
        if value is not None:
            live_metrics[key] = value
    final_metrics = _mapped_metrics(status.get("metrics") or {})
    if final_metrics:
        live_metrics.update(final_metrics)
    if live_metrics != (task.metrics_json or {}):
        task.metrics_json = live_metrics

    if remote_status in TERMINAL_STATUSES and task.status not in TERMINAL_STATUSES:
        if remote_status == "completed":
            _complete_remote_task(session, storage, node, task, status)
        else:
            error = str(status.get("error") or "") or ("Training stopped by user." if remote_status == "stopped" else "远程训练失败。")
            _salvage_checkpoints(storage, node, task, status)
            _finalize(session, task, remote_status, error)
            _cleanup_after_terminal(node, storage, task)
    session.commit()


def _salvage_checkpoints(storage: Storage, node: dict[str, Any], task: TrainingTask, status: dict[str, Any]) -> None:
    """停止/失败的远程任务尽量回收 agent 上已有的 checkpoint，保留从 last.pt 续训的能力。"""
    artifacts = status.get("artifacts") or {}
    if not isinstance(artifacts, dict):
        return
    weights_dir = storage.managed_training_path(task.run_dir or "") / "weights"
    for name in ("best", "last"):
        if not artifacts.get(name) or getattr(task, f"{name}_model_path") is not None:
            continue
        try:
            download_artifact(node, task.id, f"{name}.pt", weights_dir / f"{name}.pt")
        except (RemoteTrainingError, RemoteNodeUnavailable):
            continue
        setattr(task, f"{name}_model_path", str(weights_dir / f"{name}.pt"))


def _complete_remote_task(session: Session, storage: Storage, node: dict[str, Any], task: TrainingTask, status: dict[str, Any]) -> None:
    run_dir = storage.managed_training_path(task.run_dir or "")
    weights_dir = run_dir / "weights"
    try:
        for name in ("best", "last"):
            download_artifact(node, task.id, f"{name}.pt", weights_dir / f"{name}.pt")
        task.best_model_path = str(weights_dir / "best.pt")
        task.last_model_path = str(weights_dir / "last.pt")
        task.status = "completed"
        task.error_message = None
        task.finished_at = utc_now()
        task.progress_epoch = task.progress_total_epochs or task.epochs
        task.progress_percent = 100.0
        from app.models.service import ModelService

        registered = ModelService(storage).register_training_artifacts(session, task)
        if not registered:
            raise RemoteTrainingError("agent 未产出 best.pt / last.pt，无法注册模型。")
    except (RemoteTrainingError, RemoteNodeUnavailable) as exc:
        _finalize(session, task, "failed", f"回收远程训练产物失败：{exc}")
        return
    write_training_summary(task, task.dataset)
    TrainingLogStore(task.logs_path or "train.log").append(f"Registered {len(registered)} model artifacts from remote node.")
    _cleanup_after_terminal(node, storage, task)
    notify_training_status("completed", task)


def _finalize(session: Session, task: TrainingTask, status: str, error: str) -> None:
    task.status = status
    task.error_message = error
    task.finished_at = utc_now()
    store = TrainingLogStore(task.logs_path or "train.log")
    store.append(error)
    write_training_summary(task, task.dataset)
    session.commit()
    notify_training_status(task.status, task)


def parse_remote_device_set(device: str | None) -> set[str]:
    """拆出任务声明的 agent 设备号；auto/空无法定位具体卡，返回空集。"""
    return {part.strip() for part in str(device or "").split(",") if part.strip() and part.strip() != "auto"}


def _agent_busy_device_ids(node: dict[str, Any]) -> set[str]:
    snapshot = remote_nodes.fetch_node_snapshot(str(node.get("url") or ""), str(node.get("token") or ""))
    return {
        str(item.get("id"))
        for item in snapshot["payload"].get("devices", [])
        if isinstance(item, dict) and item.get("id") and item.get("status") == "busy"
    }


def remote_node_occupied_devices(session: Session, node: dict[str, Any], exclude_task_id: str | None = None) -> set[str]:
    """节点当前被占用的设备：agent 上报 busy + 本后端运行/排队中任务声明的设备。"""
    occupied = _agent_busy_device_ids(node)
    query = select(TrainingTask).where(
        TrainingTask.node_id == str(node.get("id") or ""),
        TrainingTask.status.in_(("pending", "running")),
    )
    for row in session.scalars(query):
        if exclude_task_id is not None and row.id == exclude_task_id:
            continue
        occupied |= parse_remote_device_set(row.device)
    return occupied


def resolve_dispatch_weights(storage: Storage, task: TrainingTask) -> Path | None:
    """任务专属权重（绝对路径：模型库/续训 last.pt）随任务推送上传。"""
    model_path = Path(task.model_path or "")
    if model_path.is_absolute():
        return model_path if model_path.is_file() else None
    return None


def agent_cached_weights(node: dict[str, Any]) -> set[str]:
    """查询 agent 已缓存的基础权重名；旧版 agent（无该接口）视为无缓存。"""
    try:
        with httpx.Client(timeout=POLL_TIMEOUT_SECONDS) as client:
            response = client.get(f"{_base(node)}/weights", headers=_headers(node))
        if response.status_code != 200:
            return set()
        values = response.json().get("weights")
        return {str(item) for item in values} if isinstance(values, list) else set()
    except (httpx.HTTPError, ValueError):
        return set()


def preset_weight_file(storage: Storage, task: TrainingTask) -> Path | None:
    """裸名基础权重：中心端 data/weights 有副本时随任务推送（不依赖 agent 回连）。"""
    stem = Path(task.model_name or "").name
    if not stem or Path(task.model_path or "").is_absolute():
        return None
    candidate = storage.data_dir / "weights" / stem
    return candidate if candidate.is_file() else None


def _cleanup_after_terminal(node: dict[str, Any] | None, storage: Storage, task: TrainingTask) -> None:
    """终态清理：删除 agent 上的任务工作区（数据集副本+产物已回收），并清后端侧数据集导出目录。"""
    if node is not None:
        delete_remote_task(node, task.id)
    export = str(task.export_path or "")
    if not export:
        return
    try:
        path = storage.managed_training_path(export)
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
    except Exception:  # noqa: BLE001 - 清理失败不影响状态流转
        logger.warning("清理任务 %s 的数据集导出失败", task.id)


def spec_from_task(task: TrainingTask) -> dict[str, Any]:
    model_arg = Path(task.model_path).name if Path(task.model_path).is_absolute() else task.model_name
    return {
        "task_id": task.id,
        "task_type": task.task_type,
        "model": model_arg,
        "epochs": task.epochs,
        "img_size": task.img_size,
        "batch_size": task.batch_size,
        "device": task.device,
        "workers": task.workers,
        "seed": task.seed,
        "optimizer": task.optimizer,
        "lr0": task.lr0,
        "patience": task.patience,
    }


def zip_export_dir(export_root: Path, archive: Path) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for item in sorted(export_root.rglob("*")):
            if item.is_file():
                zf.write(item, item.relative_to(export_root).as_posix())


def dispatch_task_from_row(session: Session, storage: Storage, node: dict[str, Any], task: TrainingTask, settings: Settings | None = None) -> bool:
    """把排队中的远程任务下发到 agent；成功转 running，失败转 failed。"""
    export_root = Path(task.export_path) if task.export_path else None
    if export_root is None or not export_root.is_dir():
        _finalize(session, task, "failed", "排队任务的数据集导出已丢失，请重试该任务。")
        return False
    spec = spec_from_task(task)
    archive = storage.tmp_dir / f"{task.id}-dataset.zip"
    zip_export_dir(export_root, archive)
    weights_path = resolve_dispatch_weights(storage, task)
    preset = preset_weight_file(storage, task)
    if weights_path is None and preset is not None and preset.name not in agent_cached_weights(node):
        weights_path = preset
    try:
        dispatch_remote_task(node, spec, archive, weights_path)
    except RemoteTrainingError as exc:
        _finalize(session, task, "failed", f"排队任务下发失败：{exc}")
        return False
    finally:
        archive.unlink(missing_ok=True)
    task.status = "running"
    task.started_at = utc_now()
    task.progress_total_epochs = task.epochs
    session.commit()
    notify_training_status("running", task)
    TrainingLogStore(task.logs_path or "train.log").append("设备已释放，任务下发到远程节点开始训练。")
    return True


def dispatch_due_remote_tasks(session: Session, storage: Storage, settings: Settings) -> None:
    """按 FIFO + 设备不重叠规则，把到期的排队任务下发到各节点。"""
    pending = list(
        session.scalars(
            select(TrainingTask)
            .where(TrainingTask.node_id.is_not(None), TrainingTask.status == "pending")
            .order_by(TrainingTask.created_at.asc(), TrainingTask.id.asc())
        )
    )
    if not pending:
        return
    by_node: dict[str, list[TrainingTask]] = {}
    for task in pending:
        by_node.setdefault(task.node_id or "", []).append(task)
    for node_id, tasks in by_node.items():
        node = find_node(settings, node_id)
        if node is None:
            for task in tasks:
                _finalize(session, task, "failed", "训练节点已被删除，远程训练无法继续。")
            session.commit()
            continue
        try:
            occupied = _agent_busy_device_ids(node)
        except RemoteNodeUnavailable:
            continue
        running_rows = session.scalars(
            select(TrainingTask).where(TrainingTask.node_id == node_id, TrainingTask.status == "running")
        )
        for row in running_rows:
            occupied |= parse_remote_device_set(row.device)
        for task in tasks:
            requested = parse_remote_device_set(task.device)
            if requested & occupied:
                continue
            if dispatch_task_from_row(session, storage, node, task, settings=settings):
                occupied |= requested


class _DispatchCancelled(Exception):
    """用户在数据下发过程中请求停止。"""


def _dispatching_update(
    session_factory: sessionmaker[Session], task_id: str, *, require_status: tuple[str, ...] | None = ("dispatching",), **fields: Any
) -> bool:
    with session_factory() as session:
        task = session.get(TrainingTask, task_id)
        if task is None or (require_status and task.status not in require_status):
            return False
        for key, value in fields.items():
            setattr(task, key, value)
        session.commit()
    return True


def _dispatch_stop_requested(session_factory: sessionmaker[Session], task_id: str) -> bool:
    with session_factory() as session:
        task = session.get(TrainingTask, task_id)
        return bool(task and task.stop_requested)


def _dispatch_flow(session_factory: sessionmaker[Session], storage: Storage, settings: Settings, task_id: str) -> None:
    """后台执行：导出数据集 → 打包 → 分块上传（进度写 progress_percent）→ 启动训练。"""
    from app.dataset.exchange.yolo import export_dataset_directory
    from app.dataset.service import get_dataset
    from app.training.service import TrainingService

    archive: Path | None = None
    try:
        with session_factory() as session:
            task = session.get(TrainingTask, task_id)
            if task is None:
                return
            node_id = task.node_id or ""
            dataset_id = task.dataset_id
            dataset_version_number = task.dataset_version_number
            include_unannotated = bool(task.include_unannotated)
            epochs = task.epochs
            export_root = storage.training_task_dir(task_id) / "dataset"

        def mark_stopped() -> None:
            _dispatching_update(session_factory, task_id, require_status=None, status="stopped", error_message="数据下发已停止。", finished_at=utc_now(), progress_percent=0.0)

        if _dispatch_stop_requested(session_factory, task_id):
            mark_stopped()
            return

        with session_factory() as session:
            dataset = get_dataset(session, dataset_id)
            from app.training.service import export_training_data

            export = export_training_data(session, storage, dataset, dataset_version_number, export_root, include_unannotated=include_unannotated)
        TrainingService._validate_export_training_splits(export, dataset.task_type, task.device, include_unannotated=include_unannotated)
        export_stats = {key: export.get(key) for key in ("counts", "annotated_image_counts", "total_image_counts", "skipped_image_counts", "label_count")}
        if not _dispatching_update(
            session_factory, task_id,
            export_path=str(export["root"]),
            data_yaml_path=str(export["data_yaml"]),
            export_stats_json=export_stats,
            progress_percent=20.0,
        ):
            return
        TrainingLogStore(storage.training_task_dir(task_id) / "train.log").append("数据集导出完成，开始打包上传。")

        if _dispatch_stop_requested(session_factory, task_id):
            mark_stopped()
            return

        archive = storage.tmp_dir / f"{task_id}-dataset.zip"
        zip_export_dir(Path(export["root"]), archive)
        if not _dispatching_update(session_factory, task_id, progress_percent=30.0):
            return

        node = find_node(settings, node_id)
        if node is None:
            _dispatching_update(session_factory, task_id, require_status=None, status="failed", error_message="训练节点已被删除，数据下发中止。", finished_at=utc_now())
            with session_factory() as session:
                row = session.get(TrainingTask, task_id)
                if row is not None:
                    _cleanup_after_terminal(None, storage, row)
            return

        # 打包后复查占用：被占用则转入排队队列，由调度器接管（复用已导出的目录）。
        with session_factory() as session:
            try:
                occupied = remote_node_occupied_devices(session, node, exclude_task_id=task_id)
            except RemoteNodeUnavailable:
                occupied = None
        requested = parse_remote_device_set(_task_device(session_factory, task_id))
        if occupied is not None and requested and requested & occupied:
            _dispatching_update(session_factory, task_id, status="pending", progress_percent=0.0)
            return

        with session_factory() as session:
            row = session.get(TrainingTask, task_id)
            if row is None or row.status not in ("dispatching",):
                return
            spec = spec_from_task(row)
            weights_path = resolve_dispatch_weights(storage, row)
            preset = preset_weight_file(storage, row)
            if preset is not None and weights_path is None:
                # agent 已缓存则不重复推送；未缓存（或旧版 agent）随任务推送
                if preset.name not in agent_cached_weights(node):
                    weights_path = preset
            elif preset is None and weights_path is None and not Path(row.model_path or "").is_absolute():
                TrainingLogStore(storage.training_task_dir(task_id) / "train.log").append(
                    f"提示：中心端基础权重库没有 {row.model_name}，训练节点需自行获取；"
                    "请在「设置 → 基础权重」上传后重试。"
                )

        def on_progress(sent: int, total: int) -> None:
            if _dispatch_stop_requested(session_factory, task_id):
                raise _DispatchCancelled
            fraction = sent / total if total else 1.0
            _dispatching_update(session_factory, task_id, progress_percent=round(min(30.0 + 60.0 * fraction, 90.0), 1))

        dispatch_remote_task(node, spec, archive, weights_path, on_progress=on_progress)
        _dispatching_update(
            session_factory, task_id, require_status=None,
            status="running", started_at=utc_now(),
            progress_epoch=0, progress_total_epochs=epochs, progress_percent=0.0,
        )
        TrainingLogStore(storage.training_task_dir(task_id) / "train.log").append("数据下发完成，远程训练已启动。")
    except _DispatchCancelled:
        _dispatching_update(session_factory, task_id, require_status=None, status="stopped", error_message="数据下发已停止。", finished_at=utc_now(), progress_percent=0.0)
    except Exception as exc:  # noqa: BLE001 - 下发失败必须落到任务状态
        logger = logging.getLogger("ywa")
        logger.warning("远程训练 %s 数据下发失败：%s", task_id, exc)
        _dispatching_update(session_factory, task_id, require_status=None, status="failed", error_message=f"数据下发失败：{exc}", finished_at=utc_now())
    finally:
        if archive is not None:
            archive.unlink(missing_ok=True)


def _task_device(session_factory: sessionmaker[Session], task_id: str) -> str:
    with session_factory() as session:
        task = session.get(TrainingTask, task_id)
        return str(task.device) if task else ""


def start_remote_dispatch(session_factory: sessionmaker[Session], storage: Storage, settings: Settings, task_id: str) -> None:
    """为 dispatching 状态的任务启动后台下发线程；只做调度，不阻塞。"""
    threading.Thread(target=_dispatch_flow, args=(session_factory, storage, settings, task_id), daemon=True, name=f"training-dispatch-{task_id}").start()


def recover_interrupted_dispatches(session_factory: sessionmaker[Session]) -> None:
    """服务重启后，把中断的下发任务标记为失败（线程已丢失，无法继续）。"""
    with session_factory() as session:
        tasks = list(session.scalars(select(TrainingTask).where(TrainingTask.status == "dispatching")))
        for task in tasks:
            task.status = "failed"
            task.error_message = "服务重启导致数据下发中断，请重试该任务。"
            task.finished_at = utc_now()
        if tasks:
            session.commit()


class RemoteTrainingPoller:
    """Mirror agent-side task state into TrainingTask rows every few seconds."""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._unreachable: dict[str, float] = {}

    def start(self, session_factory: sessionmaker[Session], storage: Storage, settings: Settings) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop,
            args=(session_factory, storage, settings),
            daemon=True,
            name="remote-training-sync",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _loop(self, session_factory: sessionmaker[Session], storage: Storage, settings: Settings) -> None:
        while not self._stop_event.wait(POLL_INTERVAL_SECONDS):
            try:
                self._tick(session_factory, storage, settings)
            except Exception:  # noqa: BLE001 - 轮询循环必须永不退出
                continue

    def _tick(self, session_factory: sessionmaker[Session], storage: Storage, settings: Settings) -> None:
        with session_factory() as session:
            dispatch_due_remote_tasks(session, storage, settings)
            tasks = list(
                session.scalars(
                    select(TrainingTask).where(
                        TrainingTask.node_id.is_not(None),
                        TrainingTask.status == "running",
                    )
                )
            )
            for task in tasks:
                try:
                    sync_remote_task(session, storage, settings, task, self._unreachable)
                except Exception:  # noqa: BLE001 - 单个任务的同步错误不影响其它任务
                    session.rollback()


remote_training_poller = RemoteTrainingPoller()
