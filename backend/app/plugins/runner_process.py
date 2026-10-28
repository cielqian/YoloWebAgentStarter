"""后端插件子进程入口:加载插件路由并以独立 HTTP 服务运行。

由平台以 `python -m app.plugins.runner_process` 拉起,配置全部来自环境变量:
  YWA_PLUGIN_ID / NAME / VERSION / ENTRY / SERVER_DIR / DATA_DIR / PORT / DATABASE_URL

隔离语义:插件代码在加载或服务期间崩溃/卡死/泄漏只影响本进程——平台通过
健康检查发现并按需重启。插件路由的保留路径校验(asset 段/空路径)也在这里
执行,违规直接以非零退出,父进程据此拒绝安装。
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path


def _fail(message: str) -> None:
    print(f"PLUGIN-STARTUP-ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(3)


def _reserved_route_path(path: str) -> bool:
    cleaned = path.strip("/")
    return cleaned == "" or cleaned == "asset" or cleaned.startswith("asset/")


def main() -> None:
    plugin_id = os.environ.get("YWA_PLUGIN_ID", "")
    name = os.environ.get("YWA_PLUGIN_NAME", plugin_id)
    version = os.environ.get("YWA_PLUGIN_VERSION", "")
    entry = Path(os.environ.get("YWA_PLUGIN_ENTRY", ""))
    server_dir = Path(os.environ.get("YWA_PLUGIN_SERVER_DIR", "."))
    data_dir = Path(os.environ.get("YWA_PLUGIN_DATA_DIR", "."))
    port = int(os.environ.get("YWA_PLUGIN_PORT", "0"))
    database_url = os.environ.get("YWA_PLUGIN_DATABASE_URL", "")

    if not plugin_id or not entry.is_file() or not port:
        _fail(f"环境变量不完整:id={plugin_id} entry={entry} port={port}")

    logging.basicConfig(level=logging.INFO, format=f"[ywa.plugin.{plugin_id}] %(levelname)s %(message)s")
    logger = logging.getLogger(f"ywa.plugin.{plugin_id}")

    sys.path.insert(0, str(server_dir))
    try:
        spec = importlib.util.spec_from_file_location(f"ywa_plugin_{plugin_id}_main", entry)
        if spec is None or spec.loader is None:
            _fail(f"无法加载后端模块 {entry}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - 任何插件代码错误都只终止本进程
        _fail(f"后端模块加载失败:{type(exc).__name__}: {exc}")

    try:
        from fastapi import APIRouter, FastAPI

        from app.core.database import Database
        from app.plugins.runtime import PluginContext
    except Exception as exc:  # noqa: BLE001
        _fail(f"平台依赖导入失败:{exc}")

    database = Database(database_url)
    data_dir.mkdir(parents=True, exist_ok=True)
    ctx = PluginContext(
        plugin_id=plugin_id,
        name=name,
        version=version,
        data_dir=data_dir,
        engine=database.engine,
        session_factory=database.session_factory,
        logger=logger,
    )

    factory = getattr(module, "create_router", None)
    if not callable(factory):
        _fail("后端模块必须导出 create_router(ctx) -> APIRouter。")
    try:
        router = factory(ctx)
    except Exception as exc:  # noqa: BLE001
        _fail(f"create_router 执行失败:{type(exc).__name__}: {exc}")
    if not isinstance(router, APIRouter):
        _fail("create_router 必须返回 fastapi.APIRouter。")
    reserved = sorted({route.path for route in router.routes if _reserved_route_path(route.path)})
    if reserved:
        _fail(f"插件路由使用了保留路径(空路径或 asset 段):{'、'.join(reserved)}。")

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/__healthz")
    def healthz() -> dict:
        return {"ok": True, "plugin": plugin_id}

    app.include_router(router)

    import uvicorn

    logger.info("插件子进程就绪 port=%s", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
