"""后端插件运行时:在平台进程内加载插件自带的路由并挂载到 /api/plugins/{id}/。

插件包可选包含 Python 后端(manifest.backend.entry 指向包内 .py 文件)。
模块需导出 create_router(ctx) -> APIRouter,返回的路由会以
/api/plugins/{id} 为前缀热挂载;卸载/重装时原路摘除。

信任模型:后端插件与平台同进程同权限运行(等同平台自身代码),
仅限管理员安装——与插件管理页的上传权限一致。插件依赖的第三方库
必须已预装在平台环境中。
"""

from __future__ import annotations

import importlib.util
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import APIRouter, FastAPI

from app.core.database import Database
from app.core.errors import ValidationError
from app.core.storage import Storage

logger = logging.getLogger("ywa")

# /api/plugins/dropins/scan 是平台管理端点,后端插件不允许占用该 id
RESERVED_PLUGIN_IDS = {"dropins"}


def _reserved_route_path(path: str) -> bool:
    """插件相对路由不允许空路径(与 /api/plugins/{id} 管理端点重叠)和 asset 段(静态资源端点)。"""
    cleaned = path.strip("/")
    return cleaned == "" or cleaned == "asset" or cleaned.startswith("asset/")


class PluginBackendError(ValidationError):
    """后端插件加载失败(安装时应整体回滚)。"""

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


class PluginRuntime:
    """已加载后端插件的注册表;进程内单例,由 create_app 配置。"""

    def __init__(self) -> None:
        self._app: FastAPI | None = None
        self._storage: Storage | None = None
        self._database: Database | None = None
        self._loaded: dict[str, dict[str, Any]] = {}

    def configure(self, app: FastAPI, storage: Storage, database: Database) -> None:
        self._app = app
        self._storage = storage
        self._database = database

    @property
    def configured(self) -> bool:
        return self._app is not None

    def _plugin_root(self) -> Path:
        assert self._storage is not None
        return self._storage.data_dir / "plugins"

    def _server_dir(self, plugin_id: str, entry: str) -> Path:
        return (self._plugin_root() / plugin_id / Path(entry).parent).resolve()

    def _context(self, manifest: dict[str, Any], plugin_id: str) -> PluginContext:
        assert self._database is not None and self._storage is not None
        data_dir = self._storage.data_dir / "plugins-data" / plugin_id
        data_dir.mkdir(parents=True, exist_ok=True)
        return PluginContext(
            plugin_id=plugin_id,
            name=str(manifest.get("name") or plugin_id),
            version=str(manifest.get("version") or ""),
            data_dir=data_dir,
            engine=self._database.engine,
            session_factory=self._database.session_factory,
            logger=logging.getLogger(f"ywa.plugin.{plugin_id}"),
        )

    def load(self, plugin_id: str, manifest: dict[str, Any]) -> bool:
        """按 manifest 加载后端;无 backend 段则原样跳过,失败抛 PluginBackendError。"""
        if self._app is None:
            return False
        if plugin_id in RESERVED_PLUGIN_IDS:
            raise PluginBackendError(f"插件 id {plugin_id} 是平台保留字,后端插件不可使用。")
        if plugin_id in self._loaded:
            self.unload(plugin_id)
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

        server_dir = self._server_dir(plugin_id, entry)
        module_name = f"ywa_plugin_{plugin_id}_main"
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        if spec is None or spec.loader is None:
            raise PluginBackendError(f"无法加载后端模块 {entry}。")
        # 兄弟模块可被插件直接 import;插件卸载时移除
        sys.path.insert(0, str(server_dir))
        try:
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        except Exception as exc:  # noqa: BLE001 - 任何加载错误都转成安装失败
            sys.modules.pop(module_name, None)
            self._remove_sys_path(server_dir)
            raise PluginBackendError(f"后端模块加载失败:{type(exc).__name__}: {exc}") from exc

        factory = getattr(module, "create_router", None)
        if not callable(factory):
            sys.modules.pop(module_name, None)
            self._remove_sys_path(server_dir)
            raise PluginBackendError("后端模块必须导出 create_router(ctx) -> APIRouter。")
        try:
            router = factory(self._context(manifest, plugin_id))
        except Exception as exc:  # noqa: BLE001
            sys.modules.pop(module_name, None)
            self._remove_sys_path(server_dir)
            raise PluginBackendError(f"create_router 执行失败:{type(exc).__name__}: {exc}") from exc
        if not isinstance(router, APIRouter):
            sys.modules.pop(module_name, None)
            self._remove_sys_path(server_dir)
            raise PluginBackendError("create_router 必须返回 fastapi.APIRouter。")
        reserved = sorted({route.path for route in router.routes if _reserved_route_path(route.path)})
        if reserved:
            sys.modules.pop(module_name, None)
            self._remove_sys_path(server_dir)
            raise PluginBackendError(
                f"插件路由使用了保留路径(空路径或 asset 段):{'、'.join(reserved)}。请调整路由前缀后重试。"
            )

        prefix = f"/api/plugins/{plugin_id}"
        before = len(self._app.router.routes)
        self._app.include_router(router, prefix=prefix)
        added = self._app.router.routes[before:]
        self._loaded[plugin_id] = {
            "module": module,
            "module_name": module_name,
            "server_dir": server_dir,
            "routes": added,
            "prefix": prefix,
        }
        self._refresh_openapi()
        logger.info("后端插件已挂载:%s → %s(%d 条路由)", plugin_id, prefix, len(added))
        return True

    def unload(self, plugin_id: str) -> None:
        record = self._loaded.pop(plugin_id, None)
        if record is None or self._app is None:
            return
        routes = self._app.router.routes
        self._app.router.routes = [route for route in routes if route not in record["routes"]]
        sys.modules.pop(record["module_name"], None)
        # 卸载该插件 server 目录下已导入的兄弟模块,避免重装时命中旧代码
        server_dir = str(record["server_dir"])
        stale = [
            name
            for name, module in list(sys.modules.items())
            if getattr(module, "__file__", None) and str(module.__file__).startswith(server_dir)
        ]
        for name in stale:
            sys.modules.pop(name, None)
        self._remove_sys_path(record["server_dir"])
        self._refresh_openapi()
        logger.info("后端插件已卸载:%s", plugin_id)

    def load_installed(self) -> list[str]:
        """启动时扫描已安装插件并加载后端;单个失败只记日志,不影响平台。"""
        from app.plugins.service import _read_installed, list_plugins

        if self._app is None:
            return []
        loaded: list[str] = []
        for plugin in list_plugins(self._storage):
            if not plugin.has_backend:
                continue
            try:
                manifest = _read_installed(self._storage, plugin.id).model_dump()
                if self.load(plugin.id, manifest):
                    loaded.append(plugin.id)
            except Exception:  # noqa: BLE001 - 启动加载失败不阻塞主服务
                logger.exception("后端插件 %s 启动加载失败,已跳过。", plugin.id)
        return loaded

    @staticmethod
    def _remove_sys_path(directory: Path) -> None:
        target = str(directory)
        sys.path[:] = [item for item in sys.path if item != target]

    def _refresh_openapi(self) -> None:
        # 热挂载/摘除后让 /docs 重新生成 schema
        self._app.openapi_cache = None  # type: ignore[attr-defined]


plugin_runtime = PluginRuntime()
