"""华为昇腾 OM 转换：把 ONNX 模型推到远程 agent 用 ATC 转换并回收 model.om。

任务只存内存（进程重启即丢，重试即可），落库的是产物 ModelVersion(format='om')。
"""

from __future__ import annotations

import threading
import time
import uuid

from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationError
from app.core.models import ModelVersion
from app.core.storage import Storage
from app.settings.service import SettingsService
from app.training.runtime.remote_training import _base, _detail, _headers

DEFAULT_SOC_VERSION = "Ascend310P3"
DEFAULT_INPUT_SHAPE = "images:1,3,640,640"
POLL_INTERVAL_SECONDS = 3.0
CONVERT_TIMEOUT_SECONDS = 20 * 60
_UPLOAD_TIMEOUT = httpx.Timeout(600.0)
_POLL_TIMEOUT = httpx.Timeout(15.0)


def _find_om_node(settings: Settings, node_id: str) -> dict[str, Any] | None:
    for node in SettingsService(settings).list_om_nodes():
        if node.get("id") == node_id:
            return node
    return None

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
_LOG_TAIL_LINES = 30


def _new_job_id() -> str:
    return f"omc_{uuid.uuid4().hex[:12]}"


def list_jobs() -> list[dict[str, Any]]:
    with _lock:
        return [dict(job) for job in _jobs.values()]


def get_job(job_id: str) -> dict[str, Any]:
    with _lock:
        job = _jobs.get(job_id)
    if job is None:
        raise NotFoundError("om_convert_job_not_found", "转换任务不存在或已随服务重启清除，请重新发起。")
    return dict(job)


def _update(job_id: str, **fields: Any) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def _attach_logs(job: dict[str, Any] | None, node: dict[str, Any], job_agent_id: str) -> None:
    if job is None:
        return
    try:
        response = httpx.get(f"{_base(node)}/convert/{job_agent_id}/logs", params={"tail": _LOG_TAIL_LINES}, headers=_headers(node), timeout=_POLL_TIMEOUT)
        if response.status_code == 200:
            job["logs"] = str(response.json().get("logs") or "")
    except httpx.HTTPError:
        pass


def start_convert(
    session_factory: sessionmaker,
    storage: Storage,
    settings: Settings,
    model_id: str,
    node_id: str,
    soc_version: str,
    input_shape: str,
) -> dict[str, Any]:
    node = _find_om_node(settings, node_id)
    if node is None:
        raise NotFoundError("training_node_not_found", "所选节点不存在，请先在设置 → Agent 配置 → OM 转换节点中添加。")
    if node.get("enabled") is False:
        raise ValidationError("training_node_disabled", "所选节点已被禁用。")
    try:
        health = httpx.get(f"{_base(node)}/health", headers=_headers(node), timeout=_POLL_TIMEOUT)
        payload = health.json() if health.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        raise ValidationError("training_node_unreachable", "节点不可达，请检查 agent 是否在线。")
    if not payload.get("convert_supported"):
        raise ValidationError("atc_unavailable", "该节点未检测到 atc 命令（需要 CANN 环境），无法转换 OM。")

    with session_factory() as session:
        source = _load_source_model(session, model_id)
        target_id = _ensure_converting_row(session, storage, source, soc_version)
        job_id = _new_job_id()
        job = {
            "job_id": job_id,
            "source_model_id": source.id,
            "source_model_name": source.name,
            "node_id": node_id,
            "node_name": str(node.get("name") or ""),
            "soc_version": soc_version,
            "input_shape": input_shape,
            "status": "uploading",
            "error": None,
            "logs": "",
            "result_model_id": target_id,
            "created_at": time.time(),
            "finished_at": None,
        }
        with _lock:
            _jobs[job_id] = job
    threading.Thread(target=_run, args=(session_factory, storage, dict(job), node), daemon=True).start()
    return dict(job)


def _target_model_id(source_model_id: str) -> str:
    return f"model_{source_model_id}_om"


def _om_file_name(session: Session, source: ModelVersion) -> str:
    """OM 文件名沿用血缘链上最近的非通用命名(与 PT/ONNX 文件同名,仅后缀不同)。

    旧版本导出的 ONNX 文件名可能是通用的 model.onnx,沿 source_model 链回溯到 PT 命名。
    """
    current: ModelVersion | None = source
    seen: set[str] = set()
    stem = ""
    while current is not None and current.id not in seen:
        seen.add(current.id)
        candidate = Path(current.model_path).stem or Path(current.name).stem
        if candidate and candidate.lower() != "model":
            stem = candidate
            break
        current = session.get(ModelVersion, current.source_model_id) if current.source_model_id else None
    return f"{stem or 'model'}.om"


def _ensure_converting_row(session: Session, storage: Storage, source: ModelVersion, soc_version: str) -> str:
    """提交即生成 OM 模型记录(status=converting)，模型列表直接展示转换进度。"""
    target_id = _target_model_id(source.id)
    existing = session.get(ModelVersion, target_id)
    if existing is None:
        session.add(
            ModelVersion(
                id=target_id,
                name=f"{Path(source.name).stem}.om",
                version=f"{source.version}-om",
                dataset_id=source.dataset_id,
                source_model_id=source.id,
                source="exported",
                artifact_type="om",
                format="om",
                task_type=source.task_type,
                engine_type="ascend-atc",
                model_path=str(storage.model_version_dir(target_id) / _om_file_name(session, source)),
                base_model=source.name,
                status="converting",
                metrics_json=dict(source.metrics_json or {}),
                notes=f"Converting from {source.name} via ATC ({soc_version}) ...",
            )
        )
    else:
        existing.status = "converting"
        existing.notes = f"Converting from {source.name} via ATC ({soc_version}) ..."
    session.commit()
    return target_id


def _load_source_model(session: Session, model_id: str) -> ModelVersion:
    model = session.get(ModelVersion, model_id)
    if model is None:
        raise NotFoundError("model_not_found", "模型不存在。")
    if model.format != "onnx":
        raise ValidationError("unsupported_model_format", "只有 ONNX 模型可以转换为 OM。")
    return model


def _run(session_factory: sessionmaker, storage: Storage, job: dict[str, Any], node: dict[str, Any]) -> None:
    job_id = job["job_id"]
    agent_job = f"ywa_{job_id}"
    base = _base(node)
    headers = _headers(node)
    failure: str | None = None
    result_model_id: str | None = None
    try:
        source_id = job["source_model_id"]
        with session_factory() as session:
            source = _load_source_model(session, source_id)
            onnx_path = storage.managed_model_path(source.model_path)
            if not onnx_path.is_file():
                raise RuntimeError(f"ONNX 文件缺失：{onnx_path}")
            onnx_bytes = onnx_path.read_bytes()

        response = httpx.post(f"{base}/convert", json={"job_id": agent_job, "soc_version": job["soc_version"], "input_shape": job["input_shape"]}, headers=headers, timeout=_POLL_TIMEOUT)
        if response.status_code != 201:
            raise RuntimeError(f"创建转换任务失败：{_detail(response)}")
        upload = httpx.put(f"{base}/convert/{agent_job}/input", content=onnx_bytes, headers=headers, timeout=_UPLOAD_TIMEOUT)
        if upload.status_code != 200:
            raise RuntimeError(f"上传 ONNX 失败：{_detail(upload)}")
        _update(job_id, status="converting")
        started = httpx.post(f"{base}/convert/{agent_job}/start", headers=headers, timeout=_POLL_TIMEOUT)
        if started.status_code != 200:
            raise RuntimeError(f"启动转换失败：{_detail(started)}")

        deadline = time.monotonic() + CONVERT_TIMEOUT_SECONDS
        status = "running"
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"转换超过 {CONVERT_TIMEOUT_SECONDS // 60} 分钟未完成。")
            time.sleep(POLL_INTERVAL_SECONDS)
            polled = httpx.get(f"{base}/convert/{agent_job}", headers=headers, timeout=_POLL_TIMEOUT)
            if polled.status_code != 200:
                raise RuntimeError(f"查询转换状态失败：{_detail(polled)}")
            payload = polled.json()
            status = str(payload.get("status") or "")
            _attach_logs(_peek(job_id), node, agent_job)
            if status in ("completed", "failed"):
                break
        if status != "completed":
            raise RuntimeError(f"ATC 转换失败：{payload.get('error') or 'agent 未返回原因'}")

        _update(job_id, status="downloading")
        artifact = httpx.get(f"{base}/convert/{agent_job}/artifacts/om", headers=headers, timeout=_UPLOAD_TIMEOUT)
        if artifact.status_code != 200:
            raise RuntimeError(f"下载 OM 失败：{_detail(artifact)}")

        with session_factory() as session:
            result_model_id = _persist_om(session, storage, job, artifact.content)
    except Exception as exc:  # noqa: BLE001 - 后台线程必须把任何异常转成任务失败
        failure = str(exc)
    finally:
        try:
            httpx.delete(f"{base}/convert/{agent_job}", headers=headers, timeout=_POLL_TIMEOUT)
        except httpx.HTTPError:
            pass
    if failure is None:
        _update(job_id, status="completed", result_model_id=result_model_id, finished_at=time.time())
    else:
        snapshot = _peek(job_id)
        if snapshot is not None:
            _attach_logs(snapshot, node, agent_job)
        _update(job_id, status="failed", error=failure, finished_at=time.time())
        _mark_row_failed(session_factory, job, failure)


def _mark_row_failed(session_factory: sessionmaker, job: dict[str, Any], failure: str) -> None:
    try:
        with session_factory() as session:
            row = session.get(ModelVersion, _target_model_id(job["source_model_id"]))
            if row is not None and row.status == "converting":
                row.status = "failed"
                row.notes = f"ATC 转换失败：{failure[:500]}"
                session.commit()
    except Exception:  # noqa: BLE001 - 失败标记自身不能抛出
        pass


def _peek(job_id: str) -> dict[str, Any] | None:
    with _lock:
        return _jobs.get(job_id)


def _persist_om(session: Session, storage: Storage, job: dict[str, Any], om_bytes: bytes) -> str:
    source = _load_source_model(session, job["source_model_id"])
    target_id = f"model_{source.id}_om"
    output_dir = storage.model_version_dir(target_id)
    output_path = output_dir / "model.om"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(om_bytes)
    managed = storage.managed_model_path(output_path)
    existing = session.get(ModelVersion, target_id)
    if existing is not None:
        existing.name = _om_file_name(session, source)
        existing.model_path = str(managed)
        existing.status = "active"
        existing.notes = f"Converted from {source.name} via ATC ({job['soc_version']})."
    else:
        session.add(
            ModelVersion(
                id=target_id,
                name=f"{Path(source.name).stem}.om",
                version=f"{source.version}-om",
                dataset_id=source.dataset_id,
                source_model_id=source.id,
                source="exported",
                artifact_type="om",
                format="om",
                task_type=source.task_type,
                engine_type="ascend-atc",
                model_path=str(managed),
                base_model=source.name,
                status="active",
                metrics_json=dict(source.metrics_json or {}),
                notes=f"Converted from {source.name} via ATC ({job['soc_version']}).",
            )
        )
    session.commit()
    return target_id
