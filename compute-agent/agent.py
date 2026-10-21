#!/usr/bin/env python3
"""YWA Compute Agent — 零依赖算力巡检 + 远程训练执行服务（仅用 Python 标准库）。

适配离线内网服务器：不需要 pip install 任何包。torch / torch_npu 若在
当前 Python 环境中可用则自动探测 CUDA / NPU 设备，否则只上报 CPU。
训练任务通过 ultralytics 子进程执行（要求该 Python 环境已装 ultralytics）。

启动：
    python3 agent.py                          # 0.0.0.0:8010，无鉴权
    python3 agent.py --port 9000 --token xxx  # 指定端口与共享密钥
    TOKEN=xxx PORT=8010 ./run.sh              # 等价封装
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
from typing import Any, Callable

AGENT_NAME = "ywa-compute-agent"
AGENT_VERSION = "0.3.2"
DEVICE_CACHE_TTL_SECONDS = 10.0
WORKSPACE_ROOT = Path(__file__).resolve().parent / "agent-workspace"
# 基础权重缓存：命中则不再向中心端拉取，训练任务共享
WEIGHTS_CACHE = Path(__file__).resolve().parent / "weights-cache"
MAX_BODY_BYTES = 32 * 1024 * 1024 * 1024
_TASK_TYPES = {"detect", "segment", "obb", "classify"}
_TASK_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_SAFE_FILE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_EPOCH_LINE = re.compile(r"^\s*(\d+)\s*/\s*(\d+)\s")
_SPEED_LINE = re.compile(r"([\d.]+)\s*(?:it|iter)/s", re.IGNORECASE)
_S_PER_ITER_LINE = re.compile(r"([\d.]+)\s*s/(?:it|iter)", re.IGNORECASE)

_device_cache: tuple[float, list[dict[str, Any]]] | None = None


# ---------------------------------------------------------------- 设备探测


def _torch():
    try:
        import torch

        return torch
    except Exception:  # noqa: BLE001 - 任何导入问题都退化为 CPU-only
        return None


def _safe(callable_value: Callable[[], Any], fallback: Any) -> Any:
    try:
        return callable_value()
    except Exception:  # noqa: BLE001 - 巡检必须永不抛错
        return fallback


def list_devices() -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = [
        {
            "id": "cpu",
            "type": "cpu",
            "name": platform.processor() or platform.machine() or "CPU",
            "index": None,
            "memory_total_mb": None,
            "memory_free_mb": None,
            "status": "available",
        }
    ]
    torch = _torch()
    if torch is None:
        _mark_busy_devices(devices)
        return devices

    try:
        mps = bool(torch.backends.mps.is_available())
    except Exception:  # noqa: BLE001
        mps = False
    if mps:
        devices.append(
            {
                "id": "mps",
                "type": "mps",
                "name": "Apple GPU (MPS)",
                "index": None,
                "memory_total_mb": None,
                "memory_free_mb": None,
                "status": "available",
            }
        )

    devices.extend(_probe_accelerators(torch, "cuda", "CUDA GPU"))
    devices.extend(_probe_accelerators(torch, "npu", "NPU", require_plugin=True))
    _mark_busy_devices(devices)
    return devices


def _probe_accelerators(torch: Any, device_type: str, label: str, require_plugin: bool = False) -> list[dict[str, Any]]:
    backend = _safe(lambda: getattr(torch, device_type), None)
    if backend is None:
        return []
    if require_plugin:
        # torch.npu 只有在 torch_npu 插件加载后才有意义，避免误报
        try:
            import torch_npu  # noqa: F401
        except Exception:  # noqa: BLE001
            return []
    if not _safe(lambda: bool(backend.is_available()), False):
        return []
    count = _safe(lambda: int(backend.device_count()), 0)
    results: list[dict[str, Any]] = []
    for index in range(count):
        name = _safe(lambda i=index: str(backend.get_device_name(i)), f"{label} {index}")
        free_mb: int | None = None
        total_mb: int | None = None
        mem_get_info = getattr(backend, "mem_get_info", None)
        if callable(mem_get_info):
            free_mb, total_mb = _safe(
                lambda i=index: (
                    int(mem_get_info(i)[0] // (1024 * 1024)),
                    int(mem_get_info(i)[1] // (1024 * 1024)),
                ),
                (None, None),
            )
        else:
            properties = _safe(lambda i=index: backend.get_device_properties(i), None)
            if properties is not None:
                total_mb = _safe(lambda p=properties: int(p.total_memory // (1024 * 1024)), None)
        results.append(
            {
                "id": f"{device_type}:{index}",
                "type": device_type,
                "name": name,
                "index": index,
                "memory_total_mb": total_mb,
                "memory_free_mb": free_mb,
                "status": "available",
            }
        )
    return results


def cached_devices() -> list[dict[str, Any]]:
    global _device_cache
    now = time.monotonic()
    if _device_cache is None or now - _device_cache[0] > DEVICE_CACHE_TTL_SECONDS:
        _device_cache = (now, list_devices())
    return _device_cache[1]


# ---------------------------------------------------------------- 训练任务


def _yolo_prefix() -> list[str]:
    override = os.getenv("YWA_YOLO_EXECUTABLE", "").strip()
    if override:
        return [override]
    found = shutil.which("yolo")
    if found:
        return [found]
    return [sys.executable, "-c", "from ultralytics.cfg import entrypoint; raise SystemExit(entrypoint())"]


def _rewrite_data_yaml_path(data_yaml: Path, dataset_dir: Path) -> None:
    """导出包里的 data.yaml 写的是后端机器的绝对路径，解压后改写为本机数据集目录。"""

    try:
        lines = data_yaml.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    rewritten = [f"path: {dataset_dir}" if line.strip().startswith("path:") else line for line in lines]
    data_yaml.write_text("\n".join(rewritten) + "\n", encoding="utf-8")


def _parse_results_csv(path: Path) -> dict[str, float]:
    if not path.is_file():
        return {}
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = [row for row in csv.DictReader(handle) if row]
    except (OSError, csv.Error, UnicodeError):
        return {}
    metrics: dict[str, float] = {}
    for key, value in (rows[-1] or {}).items():
        if not isinstance(key, str) or not isinstance(value, str) or not value.strip():
            continue
        try:
            metrics[key.strip().lower()] = float(value.strip())
        except ValueError:
            continue
    return metrics


class TaskError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class TaskManager:
    """内存 + task.json 双持久化的远程训练任务管理器。"""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.RLock()
        self.tasks: dict[str, dict[str, Any]] = {}
        self.processes: dict[str, subprocess.Popen[str]] = {}
        self.root.mkdir(parents=True, exist_ok=True)

    # --- 基础 ---

    def workspace(self, task_id: str) -> Path:
        if not _TASK_ID.fullmatch(task_id):
            raise TaskError(400, "invalid task id")
        candidate = (self.root / task_id).resolve()
        if candidate.parent != self.root.resolve():
            raise TaskError(400, "invalid task id")
        return candidate

    def _persist(self, task_id: str) -> None:
        record = self.tasks[task_id]
        state = {key: record.get(key) for key in ("spec", "status", "error", "progress", "metrics", "artifacts", "stop_requested", "created_at", "started_at", "finished_at")}
        state["task_id"] = task_id
        path = self.root / task_id / "task.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    def load_existing(self) -> None:
        if not self.root.is_dir():
            return
        for task_json in sorted(self.root.glob("*/task.json")):
            try:
                state = json.loads(task_json.read_text(encoding="utf-8"))
                task_id = str(state.get("task_id") or task_json.parent.name)
            except (OSError, ValueError):
                continue
            if not _TASK_ID.fullmatch(task_id) or task_id in self.tasks:
                continue
            if state.get("status") in ("pending", "running"):
                state["status"] = "failed"
                state["error"] = "Compute agent was restarted; the training task state was lost."
                state["finished_at"] = time.time()
            self.tasks[task_id] = state
            self._persist(task_id)

    # --- 任务生命周期 ---

    def create(self, spec: dict[str, Any]) -> dict[str, Any]:
        task_id = str(spec.get("task_id") or "")
        if not _TASK_ID.fullmatch(task_id):
            raise TaskError(400, "spec.task_id is required (1-64 chars of A-Za-z0-9_.:-)")
        task_type = str(spec.get("task_type") or "")
        if task_type not in _TASK_TYPES:
            raise TaskError(400, "spec.task_type must be one of detect/segment/obb/classify")
        model = str(spec.get("model") or "").strip()
        if not model:
            raise TaskError(400, "spec.model is required")
        normalized = {
            "task_id": task_id,
            "task_type": task_type,
            "model": model,
            "epochs": int(spec.get("epochs") or 50),
            "img_size": int(spec.get("img_size") or 640),
            "batch_size": int(spec.get("batch_size") or 16),
            "device": str(spec.get("device") or "auto"),
            "workers": int(spec.get("workers") or 2),
            "seed": int(spec.get("seed") or 42),
            "optimizer": spec.get("optimizer"),
            "lr0": spec.get("lr0"),
            "patience": spec.get("patience"),
            "weights_url": spec.get("weights_url"),
        }
        with self.lock:
            if task_id in self.tasks:
                raise TaskError(409, "task already exists")
            workspace = self.workspace(task_id)
            workspace.mkdir(parents=True, exist_ok=True)
            self.tasks[task_id] = {
                "spec": normalized,
                "status": "pending",
                "error": None,
                "progress": {"epoch": 0, "total_epochs": normalized["epochs"], "percent": 0.0},
                "metrics": {},
                "artifacts": {"best": False, "last": False},
                "stop_requested": False,
                "created_at": time.time(),
                "started_at": None,
                "finished_at": None,
            }
            self._persist(task_id)
            return self.status(task_id)

    def get(self, task_id: str) -> dict[str, Any]:
        with self.lock:
            record = self.tasks.get(task_id)
            if record is None:
                raise TaskError(404, "task not found")
            return record

    def status(self, task_id: str) -> dict[str, Any]:
        record = self.get(task_id)
        return {
            "task_id": task_id,
            "status": record.get("status"),
            "progress": record.get("progress") or {},
            "metrics": record.get("metrics") or {},
            "artifacts": record.get("artifacts") or {},
            "error": record.get("error"),
            "stop_requested": bool(record.get("stop_requested")),
            "log_line_count": self._log_lines(task_id),
            "hostname": socket.gethostname(),
            "created_at": record.get("created_at"),
            "started_at": record.get("started_at"),
            "finished_at": record.get("finished_at"),
        }

    def _log_lines(self, task_id: str) -> int:
        record = self.tasks.get(task_id)
        if record is not None and "log_line_count" in record:
            return int(record.get("log_line_count") or 0)
        path = self.root / task_id / "train.log"
        if not path.is_file():
            return 0
        try:
            return len(path.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            return 0

    def logs(self, task_id: str, after: int = 0, tail: int = 0) -> dict[str, Any]:
        self.get(task_id)
        path = self.root / task_id / "train.log"
        lines: list[str] = []
        if path.is_file():
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                lines = []
        start = max(int(after), 0)
        selected = lines[start:] if start else lines
        if tail and tail > 0:
            selected = selected[-tail:]
        return {"task_id": task_id, "logs": "\n".join(selected), "line_count": len(lines)}

    def receive_dataset(self, task_id: str, archive_path: Path) -> dict[str, Any]:
        with self.lock:
            record = self.get(task_id)
            if record.get("status") != "pending":
                raise TaskError(409, "dataset can only be uploaded before the task starts")
            workspace = self.workspace(task_id)
            dataset_dir = workspace / "dataset"
            if dataset_dir.exists():
                shutil.rmtree(dataset_dir)
            dataset_dir.mkdir(parents=True)
            root = dataset_dir.resolve()
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    for member in archive.infolist():
                        target = (root / member.filename).resolve()
                        if not str(target).startswith(str(root) + os.sep) and target != root:
                            raise TaskError(400, "dataset archive contains an unsafe path")
                        if member.is_dir():
                            target.mkdir(parents=True, exist_ok=True)
                            continue
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(member) as source, target.open("wb") as out:
                            shutil.copyfileobj(source, out)
            except zipfile.BadZipFile as exc:
                raise TaskError(400, "dataset body is not a valid zip archive") from exc
            data_yaml = dataset_dir / "data.yaml"
            if data_yaml.is_file():
                _rewrite_data_yaml_path(data_yaml, dataset_dir.resolve())
            return {"task_id": task_id, "dataset_ready": True}

    def receive_weights(self, task_id: str, name: str, data: bytes) -> dict[str, Any]:
        with self.lock:
            record = self.get(task_id)
            if record.get("status") != "pending":
                raise TaskError(409, "weights can only be uploaded before the task starts")
            if not _SAFE_FILE_NAME.fullmatch(name):
                raise TaskError(400, "weights name must be a plain file name")
            destination = self.workspace(task_id) / "weights" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            return {"task_id": task_id, "weights": name, "size_bytes": len(data)}

    def start(self, task_id: str) -> dict[str, Any]:
        with self.lock:
            record = self.get(task_id)
            if record.get("status") != "pending":
                raise TaskError(409, f"task is {record.get('status')}, only pending tasks can start")
            dataset_dir = self.workspace(task_id) / "dataset"
            if not dataset_dir.is_dir() or not any(dataset_dir.iterdir()):
                raise TaskError(409, "dataset has not been uploaded yet")
            record["status"] = "running"
            record["started_at"] = time.time()
            self._persist(task_id)
        threading.Thread(target=self._run, args=(task_id,), daemon=True).start()
        return self.status(task_id)

    def stop(self, task_id: str) -> dict[str, Any]:
        with self.lock:
            record = self.get(task_id)
            record["stop_requested"] = True
            self._persist(task_id)
            process = self.processes.get(task_id)
        if process is not None and process.poll() is None:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(process.pid), 15)
                else:
                    process.terminate()
            except (ProcessLookupError, PermissionError, OSError):
                pass
        return self.status(task_id)

    def delete(self, task_id: str) -> None:
        with self.lock:
            record = self.tasks.get(task_id)
            if record is None:
                return
            if record.get("status") == "running":
                raise TaskError(409, "stop the task before deleting it")
            del self.tasks[task_id]
            workspace = self.workspace(task_id)
        if workspace.exists():
            shutil.rmtree(workspace, ignore_errors=True)

    def artifact_path(self, task_id: str, name: str) -> Path:
        if name not in ("best.pt", "last.pt"):
            raise TaskError(400, "artifact must be best.pt or last.pt")
        self.get(task_id)
        path = self.workspace(task_id) / "run" / "weights" / name
        if not path.is_file():
            raise TaskError(404, f"{name} is not ready yet")
        return path

    def resolve_base_weight(self, model_ref: str, spec: dict[str, Any], log) -> str:
        """基础权重解析：本地缓存命中直接用；未命中且中心端提供地址则拉取入缓存。"""
        name = Path(model_ref).name
        if not name.endswith(".pt"):
            return model_ref
        WEIGHTS_CACHE.mkdir(parents=True, exist_ok=True)
        cached = WEIGHTS_CACHE / name
        if cached.is_file():
            log(f"基础权重命中本地缓存：{cached}")
            return str(cached)
        return self._pull_weight(model_ref, spec, cached, log)

    def _pull_weight(self, model_ref: str, spec: dict[str, Any], destination: Path, log) -> str:
        url = str(spec.get("weights_url") or "").strip()
        if not url:
            log(f"未找到基础权重 {model_ref} 的本地副本，且任务未提供中心端权重地址；将交给 ultralytics 自行解析（离线环境会失败）。")
            return model_ref
        import urllib.request

        log(f"本地无基础权重 {model_ref}，向中心端拉取：{url}")
        temporary = destination.with_suffix(".downloading")
        try:
            with urllib.request.urlopen(url, timeout=600) as response, temporary.open("wb") as handle:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    handle.write(block)
            temporary.replace(destination)
            log(f"基础权重已拉取并缓存：{destination}")
            return str(destination)
        except Exception as exc:  # noqa: BLE001 - 拉取失败退回原始引用
            temporary.unlink(missing_ok=True)
            log(f"从中心端拉取基础权重失败：{exc}")
            return model_ref

    # --- 子进程执行 ---

    def _run(self, task_id: str) -> None:
        workspace = self.workspace(task_id)
        record = self.tasks[task_id]
        spec = record["spec"]
        log_path = workspace / "train.log"

        def log(text: str) -> None:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(text + "\n")
            record["log_line_count"] = int(record.get("log_line_count") or 0) + 1

        dataset_dir = (workspace / "dataset").resolve()
        data_yaml = dataset_dir / "data.yaml"
        data_arg = str(data_yaml) if data_yaml.is_file() else str(dataset_dir)
        model_ref = str(spec.get("model") or "")
        weights_candidate = workspace / "weights" / Path(model_ref).name
        if weights_candidate.is_file():
            model_ref = str(weights_candidate)
        else:
            model_ref = str(self.resolve_base_weight(model_ref, spec, log))
        args = [
            *_yolo_prefix(),
            str(spec["task_type"]),
            "train",
            f"model={model_ref}",
            f"data={data_arg}",
            f"epochs={int(spec['epochs'])}",
            f"imgsz={int(spec['img_size'])}",
            f"batch={int(spec['batch_size'])}",
            f"project={workspace}",
            "name=run",
            "exist_ok=True",
            f"workers={int(spec['workers'])}",
            f"seed={int(spec['seed'])}",
        ]
        device = str(spec.get("device") or "auto").strip()
        if device and device != "auto":
            args.append(f"device={device}")
        if spec.get("optimizer"):
            args.append(f"optimizer={spec['optimizer']}")
        if spec.get("lr0") is not None:
            args.append(f"lr0={spec['lr0']}")
        if spec.get("patience") is not None:
            args.append(f"patience={spec['patience']}")

        log(f"Training started on {socket.gethostname()}.")
        log("Command: " + " ".join(args))
        return_code = -1
        try:
            process = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                shell=False,
                start_new_session=os.name == "posix",
            )
            with self.lock:
                self.processes[task_id] = process
                if record.get("stop_requested"):
                    self.stop(task_id)
            assert process.stdout is not None
            for line in process.stdout:
                clean = line.rstrip("\n")
                log(clean)
                self._track_progress(task_id, clean)
            return_code = process.wait()
        except Exception as exc:  # noqa: BLE001 - 任何启动失败都转为任务失败
            log(f"Training process failed to start or read output: {exc}")
        finally:
            with self.lock:
                self.processes.pop(task_id, None)

        best = workspace / "run" / "weights" / "best.pt"
        last = workspace / "run" / "weights" / "last.pt"
        with self.lock:
            record["artifacts"] = {"best": best.is_file(), "last": last.is_file()}
            record["metrics"] = _parse_results_csv(workspace / "run" / "results.csv")
            progress = dict(record.get("progress") or {})
            total = int(progress.get("total_epochs") or spec["epochs"] or 1)
            record["finished_at"] = time.time()
            if record.get("stop_requested"):
                record["status"] = "stopped"
                record["error"] = "Training stopped by user."
                log("Training stopped by user.")
            elif return_code == 0 and best.is_file() and last.is_file():
                record["status"] = "completed"
                record["error"] = None
                progress.update({"epoch": total, "total_epochs": total, "percent": 100.0})
                record["progress"] = progress
                log("Training completed with best.pt and last.pt.")
            else:
                record["status"] = "failed"
                record["error"] = (
                    "Training finished without both best.pt and last.pt."
                    if return_code == 0
                    else f"YOLO training exited with code {return_code}."
                )
                log(record["error"])
            self._persist(task_id)

    def _track_progress(self, task_id: str, line: str) -> None:
        record = self.tasks.get(task_id)
        if record is None:
            return
        progress = dict(record.get("progress") or {})
        match = _EPOCH_LINE.match(line)
        if match:
            total = max(int(match.group(2)), 1)
            epoch = min(int(match.group(1)), total)
            progress.update({"epoch": epoch, "total_epochs": total, "percent": round(epoch / total * 100, 2)})
        speed = _SPEED_LINE.search(line)
        iterations_per_second = speed is not None
        if speed is None:
            speed = _S_PER_ITER_LINE.search(line)
        if speed:
            value = _safe(lambda: float(speed.group(1)), None)
            if value and value > 0:
                if iterations_per_second:
                    progress["speed_it_per_sec"] = value
                    progress["batch_time_seconds"] = 1.0 / value
                else:
                    progress["batch_time_seconds"] = value
                    progress["speed_it_per_sec"] = 1.0 / value
        if progress != (record.get("progress") or {}):
            record["progress"] = progress


task_manager = TaskManager(WORKSPACE_ROOT)


def _running_device_ids() -> set[str]:
    """当前运行中任务声明的设备；auto 无法拆分，单独返回哨兵值。"""
    with task_manager.lock:
        records = [record for record in task_manager.tasks.values() if record.get("status") == "running"]
    used: set[str] = set()
    for record in records:
        device = str((record.get("spec") or {}).get("device") or "").strip()
        if device == "auto":
            used.add("auto")
            continue
        if not device:
            continue
        used.update(part.strip() for part in device.split(",") if part.strip())
    return used


def _mark_busy_devices(devices: list[dict[str, Any]]) -> None:
    running = _running_device_ids()
    if not running:
        return
    accelerators = [item for item in devices if item.get("type") != "cpu"]
    for item in devices:
        if item.get("id") in running:
            item["status"] = "busy"
        elif "auto" in running and accelerators and item.get("id") == accelerators[0].get("id"):
            # auto 模式由 Ultralytics 选卡，视为占用首张加速卡
            item["status"] = "busy"


# ---------------------------------------------------------------- HTTP 服务


def make_handler(token: str) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = AGENT_NAME + "/" + AGENT_VERSION

        def _authorized(self) -> bool:
            if not token:
                return True
            provided = self.headers.get("X-Agent-Token", "")
            if not provided:
                authorization = self.headers.get("Authorization", "")
                if authorization.lower().startswith("bearer "):
                    provided = authorization[7:].strip()
            return provided == token

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_bytes(self, status: int, body: bytes, content_type: str, file_name: str | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if file_name:
                self.send_header("Content-Disposition", f'attachment; filename="{file_name}"')
            self.end_headers()
            self.wfile.write(body)

        def _guard(self) -> bool:
            if not self._authorized():
                self._send(401, {"detail": "invalid agent token"})
                return False
            return True

        def _segments(self) -> list[str]:
            return [segment for segment in self.path.split("?", 1)[0].split("/") if segment]

        def _read_body(self) -> bytes:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0:
                return b""
            if length > MAX_BODY_BYTES:
                raise TaskError(413, "request body too large")
            return self.rfile.read(length)

        def _read_body_to_file(self, destination: Path) -> int:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0:
                raise TaskError(400, "request body is empty")
            if length > MAX_BODY_BYTES:
                raise TaskError(413, "request body too large")
            destination.parent.mkdir(parents=True, exist_ok=True)
            remaining = length
            written = 0
            with destination.open("wb") as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
                    written += len(chunk)
            if written != length:
                raise TaskError(400, "request body was truncated")
            return written

        # --- GET ---

        def do_GET(self) -> None:  # noqa: N802 - http.server 约定命名
            if not self._guard():
                return
            segments = self._segments()
            if not segments:
                self._send(404, {"detail": "not found"})
                return
            if segments == ["health"]:
                self._send(
                    200,
                    {
                        "ok": True,
                        "agent": AGENT_NAME,
                        "version": AGENT_VERSION,
                        "hostname": socket.gethostname(),
                        "auth_required": bool(token),
                        "training_supported": True,
                        "timestamp": time.time(),
                    },
                )
                return
            if segments == ["devices"]:
                self._send(
                    200,
                    {
                        "agent": AGENT_NAME,
                        "version": AGENT_VERSION,
                        "hostname": socket.gethostname(),
                        "timestamp": time.time(),
                        "devices": cached_devices(),
                    },
                )
                return
            try:
                if len(segments) == 2 and segments[0] == "tasks":
                    self._send(200, task_manager.status(segments[1]))
                    return
                if len(segments) == 3 and segments[0] == "tasks" and segments[2] == "logs":
                    params = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                    after = int((params.get("after") or ["0"])[0] or 0)
                    tail = int((params.get("tail") or ["0"])[0] or 0)
                    self._send(200, task_manager.logs(segments[1], after=after, tail=tail))
                    return
                if len(segments) == 4 and segments[0] == "tasks" and segments[2] == "artifacts":
                    path = task_manager.artifact_path(segments[1], segments[3])
                    self._send_bytes(200, path.read_bytes(), "application/octet-stream", path.name)
                    return
            except TaskError as exc:
                self._send(exc.status, {"detail": exc.message})
                return
            except OSError as exc:
                self._send(500, {"detail": f"artifact read failed: {exc}"})
                return
            self._send(404, {"detail": "not found"})

        # --- POST / PUT / DELETE ---

        def do_POST(self) -> None:  # noqa: N802
            if not self._guard():
                return
            segments = self._segments()
            try:
                if segments == ["tasks"]:
                    try:
                        spec = json.loads(self._read_body().decode("utf-8"))
                    except (ValueError, UnicodeError) as exc:
                        self._send(400, {"detail": "request body must be a JSON task spec"})
                        return
                    if not isinstance(spec, dict):
                        self._send(400, {"detail": "request body must be a JSON task spec"})
                        return
                    self._send(201, task_manager.create(spec))
                    return
                if len(segments) == 3 and segments[0] == "tasks" and segments[2] in ("start", "stop"):
                    if segments[2] == "start":
                        self._read_body()
                        self._send(200, task_manager.start(segments[1]))
                    else:
                        self._read_body()
                        self._send(200, task_manager.stop(segments[1]))
                    return
            except TaskError as exc:
                self._send(exc.status, {"detail": exc.message})
                return
            self._send(404, {"detail": "not found"})

        def do_PUT(self) -> None:  # noqa: N802
            if not self._guard():
                return
            segments = self._segments()
            try:
                if len(segments) == 3 and segments[0] == "tasks" and segments[2] == "dataset":
                    archive = task_manager.workspace(segments[1]) / "dataset.zip"
                    self._read_body_to_file(archive)
                    self._send(200, task_manager.receive_dataset(segments[1], archive))
                    return
                if len(segments) == 3 and segments[0] == "tasks" and segments[2] == "weights":
                    params = parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                    name = (params.get("name") or [""])[0]
                    body = self._read_body()
                    self._send(200, task_manager.receive_weights(segments[1], name, body))
                    return
            except TaskError as exc:
                self._send(exc.status, {"detail": exc.message})
                return
            self._send(404, {"detail": "not found"})

        def do_DELETE(self) -> None:  # noqa: N802
            if not self._guard():
                return
            segments = self._segments()
            try:
                if len(segments) == 2 and segments[0] == "tasks":
                    self._read_body()
                    task_manager.delete(segments[1])
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            except TaskError as exc:
                self._send(exc.status, {"detail": exc.message})
                return
            self._send(404, {"detail": "not found"})

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), format % args))

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="YWA compute agent: zero-dependency device inspection and remote training service")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8010")))
    parser.add_argument("--token", default=os.environ.get("YWA_AGENT_TOKEN", os.environ.get("TOKEN", "")))
    parser.add_argument("--version", action="version", version=AGENT_VERSION)
    args = parser.parse_args()

    # systemd 服务默认不带 HOME；补上以启用 torch kernel cache，避免首跑 JIT 编译极慢。
    if not os.environ.get("HOME"):
        os.environ["HOME"] = str(Path.home())

    task_manager.load_existing()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(args.token.strip()))
    torch = _torch()
    print(
        f"{AGENT_NAME} v{AGENT_VERSION} listening on http://{args.host}:{args.port} "
        f"(auth={'on' if args.token.strip() else 'OFF'}, torch={'yes' if torch is not None else 'no'}, "
        f"workspace={WORKSPACE_ROOT}, python={sys.version.split()[0]})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
