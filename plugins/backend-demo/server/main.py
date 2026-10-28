"""后端插件示例:演示 create_router(ctx) 契约。

挂载后路由前缀为 /api/plugins/backend-demo,前端可用 __ctx 里的
pluginApiBase 直接拼接调用。ctx 提供平台数据库会话、私有数据目录与日志。
"""

from __future__ import annotations

import json

from fastapi import APIRouter
from sqlalchemy import text


def create_router(ctx) -> APIRouter:  # noqa: ANN001 - ctx 由平台注入(PluginContext)
    router = APIRouter()

    @router.get("/ping")
    def ping() -> dict:
        return {"ok": True, "plugin": ctx.plugin_id, "version": ctx.version}

    @router.get("/platform-stats")
    def platform_stats() -> dict:
        with ctx.session_factory() as session:
            datasets = session.execute(text("SELECT COUNT(*) FROM datasets")).scalar()
            images = session.execute(text("SELECT COUNT(*) FROM image_items")).scalar()
        ctx.logger.info("platform-stats queried")
        return {"datasets": datasets, "images": images}

    @router.post("/counter")
    def counter() -> dict:
        """计数器存在插件私有数据目录,跨请求持久,重装不丢。"""
        state_file = ctx.data_dir / "counter.json"
        value = 0
        if state_file.is_file():
            value = json.loads(state_file.read_text(encoding="utf-8"))["value"]
        value += 1
        state_file.write_text(json.dumps({"value": value}), encoding="utf-8")
        return {"value": value}

    return router
