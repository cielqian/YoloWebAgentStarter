"""Remote training dispatch and state sync against compute-agent nodes.

Backend owns the TrainingTask row; the agent owns the actual subprocess. The
dispatch flow is: export the dataset to a zip, upload it plus optional base
weights, then start. A background poller mirrors agent status, progress, logs,
and final artifacts back into the managed training directory.
"""

from __future__ import annotations

import threading
import time
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
from app.training.runtime.remote_nodes import RemoteNodeUnavailable

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
) -> None:
    task_id = str(spec["task_id"])
    base = _base(node)
    headers = _headers(node)
    try:
        with httpx.Client(timeout=DISPATCH_TIMEOUT_SECONDS) as client:
            response = client.post(f"{base}/tasks", json=spec, headers=headers)
            if response.status_code not in (201, 409):
                raise RemoteTrainingError(f"创建任务失败：{_detail(response)}")
            with dataset_zip.open("rb") as handle:
                response = client.put(
                    f"{base}/tasks/{task_id}/dataset",
                    content=handle,
                    headers={**headers, "Content-Type": "application/zip"},
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
    if not task.logs_path:
        return
    store = TrainingLogStore(task.logs_path)
    local_count = store.line_count()
    payload = fetch_task_logs(node, task.id, after=local_count)
    if int(payload.get("line_count") or 0) < local_count:
        return
    new_logs = str(payload.get("logs") or "")
    if new_logs.strip():
        store.append(new_logs)


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
            _finalize(session, task, remote_status, error)
    session.commit()


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


def _finalize(session: Session, task: TrainingTask, status: str, error: str) -> None:
    task.status = status
    task.error_message = error
    task.finished_at = utc_now()
    store = TrainingLogStore(task.logs_path or "train.log")
    store.append(error)
    write_training_summary(task, task.dataset)
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
            tasks = list(
                session.scalars(
                    select(TrainingTask).where(
                        TrainingTask.node_id.is_not(None),
                        TrainingTask.status.in_(("pending", "running")),
                    )
                )
            )
            for task in tasks:
                try:
                    sync_remote_task(session, storage, settings, task, self._unreachable)
                except Exception:  # noqa: BLE001 - 单个任务的同步错误不影响其它任务
                    session.rollback()


remote_training_poller = RemoteTrainingPoller()
