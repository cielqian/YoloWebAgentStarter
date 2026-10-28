"""后端插件运行时:每个插件运行在独立子进程中,平台反向代理其接口。

隔离保证(fault isolation):
- 插件崩溃/卡死/内存泄漏只影响它自己的进程;平台进程不受任何影响
- 子进程受资源限额(内存/CPU)约束,并输出到专属日志文件
- 启动失败的插件只被标记为不可用,平台照常运行;请求到达时按冷却窗口自愈重启
- 平台重启后自动拉起所有已装插件

注意:这是故障隔离,不是恶意代码安全沙箱——子进程与平台同主机、共享数据库
凭证,插件仍属受信代码(仅管理员安装)。

插件作者契约不变:create_router(ctx) -> APIRouter,见 docs/PLUGIN_SPEC.md 第 5 节。
"""

from __future__ import annotations

import hashlib
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from app.core.database import Database
from app.core.errors import ValidationError
from app.core.storage import Storage

logger = logging.getLogger("ywa")

# /api/plugins/dropins/scan 是平台管理端点,后端插件不允许占用该 id
RESERVED_PLUGIN_IDS = {"dropins"}

_PORT_BASE = 18100
_PORT_RANGE = 800
_STARTUP_TIMEOUT_SECONDS = 20.0
_PROXY_TIMEOUT_SECONDS = 300.0
_SANDBOX_MEMORY_BYTES = 1 << 30  # 子进程地址空间上限 1GB
_SANDBOX_CPU_SECONDS = 4 * 3600


def _restart_cooldown_seconds() -> float:
    """崩溃后自动重启的冷却窗口(防崩溃循环),可用 YWA_PLUGIN_RESTART_COOLDOWN 覆盖。"""
    try:
        return float(os.environ.get("YWA_PLUGIN_RESTART_COOLDOWN", "30"))
    except ValueError:
        return 30.0


class PluginBackendError(ValidationError):
    """后端插件启动失败(安装时应整体回滚)。"""

    def __init__(self, message: str) -> None:
        super().__init__("plugin_backend_invalid", message)


@dataclass(frozen=True)
class PluginContext:
    """暴露给后端插件的运行时上下文(受支持能力的全部边界)。"""

    plugin_id: str
    name: str
    version: str
    data_dir: Path
    engine: Any
    session_factory: Any
    logger: logging.Logger


def _reserved_route_path(path: str) -> bool:
    """插件相对路由不允许空路径(与 /api/plugins/{id} 管理端点重叠)和 asset 段(静态资源端点)。"""
    cleaned = path.strip("/")
    return cleaned == "" or cleaned == "asset" or cleaned.startswith("asset/")


class _ChildRecord:
    def __init__(self, plugin_id: str, manifest: dict[str, Any], port: int, log_path: Path) -> None:
        self.plugin_id = plugin_id
        self.manifest = manifest
        self.port = port
        self.log_path = log_path
        self.process: subprocess.Popen | None = None
        self.last_start_attempt = 0.0


class PluginRuntime:
    """子进程后端插件的注册表;进程内单例,由 create_app 配置。"""

    def __init__(self) -> None:
        self._app: FastAPI | None = None
        self._storage: Storage | None = None
        self._database: Database | None = None
        self._children: dict[str, _ChildRecord] = {}
        self._ports_in_use: set[int] = set()

    def configure(self, app: FastAPI, storage: Storage, database: Database) -> None:
        self._app = app
        self._storage = storage
        self._database = database

    @property
    def configured(self) -> bool:
        return self._storage is not None

    def _plugin_root(self) -> Path:
        assert self._storage is not None
        return self._storage.data_dir / "plugins"

    def _data_root(self) -> Path:
        assert self._storage is not None
        return self._storage.data_dir / "plugins-data"

    def _runner_module_dir(self) -> Path:
        return Path(__file__).resolve().parents[2]  # app 包的父目录(python -m 可导入 app.*)

    # ---- 端口分配 ----

    def _pick_port(self, plugin_id: str) -> int:
        digest = int.from_bytes(hashlib.sha256(plugin_id.encode()).digest()[:4], "big")
        candidates = [(_PORT_BASE + digest % _PORT_RANGE + offset) % (_PORT_BASE + _PORT_RANGE) for offset in range(8)]
        for port in candidates:
            if port in self._ports_in_use:
                continue
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
        raise PluginBackendError("没有可用的插件端口(18100-18999)。")

    # ---- 子进程生命周期 ----

    def _spawn(self, record: _ChildRecord) -> None:
        assert self._database is not None
        entry = str(record.manifest.get("backend", {}).get("entry", ""))
        plugin_dir = (self._plugin_root() / record.plugin_id).resolve()
        server_dir = (plugin_dir / Path(entry).parent).resolve()
        data_dir = self._data_root() / record.plugin_id
        data_dir.mkdir(parents=True, exist_ok=True)
        record.log_path.parent.mkdir(parents=True, exist_ok=True)

        environment = dict(os.environ)
        environment.update(
            {
                "YWA_PLUGIN_ID": record.plugin_id,
                "YWA_PLUGIN_NAME": str(record.manifest.get("name") or record.plugin_id),
                "YWA_PLUGIN_VERSION": str(record.manifest.get("version") or ""),
                "YWA_PLUGIN_ENTRY": str(plugin_dir / entry),
                "YWA_PLUGIN_SERVER_DIR": str(server_dir),
                "YWA_PLUGIN_DATA_DIR": str(data_dir),
                "YWA_PLUGIN_PORT": str(record.port),
                "YWA_PLUGIN_DATABASE_URL": self._database.engine.url.render_as_string(hide_password=False),
                "PYTHONPATH": os.pathsep.join(filter(None, [str(self._runner_module_dir()), environment.get("PYTHONPATH", "")])),
            }
        )
        log_handle = record.log_path.open("ab")

        def _apply_limits() -> None:  # 仅 POSIX;在 fork 后 exec 前限制子进程资源
            try:
                import resource

                resource.setrlimit(resource.RLIMIT_AS, (_SANDBOX_MEMORY_BYTES, _SANDBOX_MEMORY_BYTES))
                resource.setrlimit(resource.RLIMIT_CPU, (_SANDBOX_CPU_SECONDS, _SANDBOX_CPU_SECONDS))
            except Exception:  # noqa: BLE001 - 限额失败不阻止启动
                pass

        record.last_start_attempt = time.monotonic()
        record.process = subprocess.Popen(
            [sys.executable, "-m", "app.plugins.runner_process"],
            env=environment,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=os.name == "posix",
            preexec_fn=_apply_limits if os.name == "posix" else None,
        )

    def _wait_ready(self, record: _ChildRecord, timeout: float = _STARTUP_TIMEOUT_SECONDS) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if record.process is not None and record.process.poll() is not None:
                return False  # 子进程已退出
            try:
                response = httpx.get(f"http://127.0.0.1:{record.port}/__healthz", timeout=2.0)
                if response.status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            time.sleep(0.3)
        return False

    def _startup_error(self, record: _ChildRecord) -> str:
        try:
            lines = record.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            interesting = [line for line in lines[-15:] if "PLUGIN-STARTUP-ERROR" in line or "Error" in line or "Traceback" in line]
            detail = interesting[-1] if interesting else (lines[-1] if lines else "无输出")
        except OSError:
            detail = "无日志"
        return f"后端插件启动失败({record.plugin_id}):{detail[:500]}(完整日志:{record.log_path})"

    def load(self, plugin_id: str, manifest: dict[str, Any]) -> bool:
        """按 manifest 拉起子进程;无 backend 段则跳过,失败抛 PluginBackendError。"""
        if not self.configured:
            return False
        if plugin_id in RESERVED_PLUGIN_IDS:
            raise PluginBackendError(f"插件 id {plugin_id} 是平台保留字,后端插件不可使用。")
        backend = manifest.get("backend") or {}
        entry = str(backend.get("entry") or "").strip()
        if not entry:
            return False
        if ".." in entry.split("/") or "\\" in entry or not entry.endswith(".py"):
            raise PluginBackendError("backend.entry 必须是包内相对 .py 路径,不能包含 .. 或反斜杠。")

        module_path = (self._plugin_root() / plugin_id / entry).resolve()
        plugin_root = (self._plugin_root() / plugin_id).resolve()
        if plugin_root not in module_path.parents:
            raise PluginBackendError("backend.entry 越出了插件目录。")
        if not module_path.is_file():
            raise PluginBackendError(f"后端入口文件 {entry} 不在插件包内。")

        if plugin_id in self._children:
            self.unload(plugin_id)
        record = _ChildRecord(plugin_id, manifest, self._pick_port(plugin_id), self._data_root() / plugin_id / "runner.log")
        self._children[plugin_id] = record
        self._ports_in_use.add(record.port)
        self._spawn(record)
        if not self._wait_ready(record):
            self.unload(plugin_id)
            raise PluginBackendError(self._startup_error(record))
        logger.info("后端插件子进程就绪:%s → 127.0.0.1:%d", plugin_id, record.port)
        return True

    def unload(self, plugin_id: str) -> None:
        record = self._children.pop(plugin_id, None)
        if record is None:
            return
        self._ports_in_use.discard(record.port)
        process = record.process
        record.process = None
        if process is None or process.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            else:
                process.terminate()
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                else:
                    process.kill()
            except (ProcessLookupError, OSError):
                pass
            process.wait(timeout=5)
        logger.info("后端插件子进程已停止:%s", plugin_id)

    def _ensure_running(self, record: _ChildRecord) -> bool:
        if record.process is not None and record.process.poll() is None:
            return True
        if time.monotonic() - record.last_start_attempt < _restart_cooldown_seconds():
            return False
        logger.warning("后端插件 %s 子进程不在运行,尝试重启。", record.plugin_id)
        self._spawn(record)
        if not self._wait_ready(record):
            logger.error(self._startup_error(record))
            return False
        return True

    def load_installed(self) -> list[str]:
        """拉起所有已装插件子进程;单个失败只记日志,绝不影响平台。

        历史教训:不要在 uvicorn lifespan 启动序列里调用本方法——事件循环
        线程中 fork 子进程会触发竞态,使 uvicorn 启动被静默中断(exit 3)。
        平台启动路径请使用 start_installed_in_background()。
        """
        from app.plugins.service import list_plugins

        if not self.configured:
            return []
        records: list[_ChildRecord] = []
        for plugin in list_plugins(self._storage):
            if not plugin.has_backend:
                continue
            if plugin.id in self._children:
                continue  # 已在运行(如安装时已拉起),避免后台加载与安装并发双起子进程
            manifest_path = self._plugin_root() / plugin.id / "manifest.json"
            try:
                import json

                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                logger.exception("后端插件 %s 的 manifest 读取失败,已跳过。", plugin.id)
                continue
            if plugin.id in RESERVED_PLUGIN_IDS:
                continue
            record = _ChildRecord(plugin.id, manifest, self._pick_port(plugin.id), self._data_root() / plugin.id / "runner.log")
            self._children[plugin.id] = record
            self._ports_in_use.add(record.port)
            self._spawn(record)
            records.append(record)

        ready: list[str] = []
        if records:
            with ThreadPoolExecutor(max_workers=max(1, len(records))) as pool:
                for record, ok in zip(records, pool.map(self._wait_ready, records), strict=True):
                    if ok:
                        ready.append(record.plugin_id)
                    else:
                        logger.error(self._startup_error(record))
        if ready:
            logger.info("后端插件子进程就绪:%s", ready)
        return ready

    def start_installed_in_background(self) -> None:
        """平台启动完成后由后台线程加载插件子进程(绝不能在 lifespan 里同步做)。"""

        def run() -> None:
            time.sleep(1.0)  # 让 uvicorn 启动序列先走完
            try:
                self.load_installed()
            except Exception:  # noqa: BLE001 - 插件加载失败绝不影响平台
                logger.exception("后端插件启动加载失败")

        threading.Thread(target=run, daemon=True, name="plugin-runtime-loader").start()

    # ---- 请求代理 ----

    def proxy(self, plugin_id: str, path: str, request: Request, body: bytes) -> Response:
        record = self._children.get(plugin_id)
        if record is None:
            return JSONResponse(
                {"error": {"code": "plugin_backend_not_found", "message": "该插件不存在或没有后端。"}},
                status_code=404,
            )
        if not self._ensure_running(record):
            return JSONResponse(
                {"error": {"code": "plugin_backend_unavailable", "message": "插件后端不可用(启动失败或正在重启),稍后重试;详见插件运行日志。"}},
                status_code=503,
            )
        url = f"http://127.0.0.1:{record.port}{path}"
        headers = {"content-type": request.headers["content-type"]} if "content-type" in request.headers else {}
        for attempt in range(2):
            try:
                response = httpx.request(
                    request.method,
                    url,
                    content=body if request.method not in ("GET", "HEAD") else None,
                    headers=headers,
                    params=dict(request.query_params),
                    timeout=_PROXY_TIMEOUT_SECONDS,
                )
            except httpx.HTTPError:
                if attempt == 0 and self._ensure_running(record):
                    continue  # 子进程请求中途挂掉:重启后重试一次
                return JSONResponse(
                    {"error": {"code": "plugin_backend_unavailable", "message": "插件后端请求失败,已尝试重启;若持续失败请查看插件运行日志。"}},
                    status_code=503,
                )
            passthrough = {key: response.headers[key] for key in ("content-type", "content-disposition") if key in response.headers}
            return Response(content=response.content, status_code=response.status_code, headers=passthrough)
        return JSONResponse({"error": {"code": "plugin_backend_unavailable", "message": "插件后端不可用。"}}, status_code=503)


plugin_runtime = PluginRuntime()
