from __future__ import annotations

from fastapi import APIRouter, Depends, File, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.api.dependencies import get_settings, get_storage
from app.core.config import Settings
from app.core.storage import Storage
from app.plugins import service
from app.plugins.runtime import plugin_runtime
from app.plugins.schemas import PluginOut

router = APIRouter(prefix="/plugins", tags=["plugins"])


@router.get("", response_model=dict)
def list_plugins(storage: Storage = Depends(get_storage)) -> dict:
    """列表前顺带扫描 dropins 目录，实现“放入即自动装载”。"""
    try:
        service.scan_dropins(storage)
    except Exception:  # noqa: BLE001 - 扫描失败不阻塞列表
        pass
    return {
        "items": [plugin.model_dump(mode="json") for plugin in service.list_plugins(storage)],
        "dropins_dir": str(service.dropins_dir(storage)),
    }


@router.post("/dropins/scan", response_model=list[PluginOut])
def scan_dropins(storage: Storage = Depends(get_storage)) -> list[PluginOut]:
    return service.scan_dropins(storage)


@router.post("/install", response_model=PluginOut, status_code=201)
async def install_plugin(file: UploadFile = File(...), storage: Storage = Depends(get_storage)) -> PluginOut:
    if not (file.filename or "").lower().endswith(".zip"):
        return Response(status_code=422, content='{"error":{"code":"plugin_zip_required","message":"仅支持 .zip 插件包。"}}', media_type="application/json")  # type: ignore[return-value]
    payload = await file.read(service.MAX_ZIP_BYTES + 1)
    return service.install_zip(storage, payload)


@router.delete("/{plugin_id}", status_code=204, response_class=Response, response_model=None)
def delete_plugin(plugin_id: str, storage: Storage = Depends(get_storage)) -> None:
    service.delete_plugin(storage, plugin_id)


@router.get("/{plugin_id}/asset/{file_path:path}")
def plugin_asset(plugin_id: str, file_path: str, storage: Storage = Depends(get_storage)) -> FileResponse:
    path, media_type = service.resolve_asset(storage, plugin_id, file_path)
    return FileResponse(path, media_type=media_type)


# 兜底代理:后端插件路由全部转发到各自子进程。必须定义在本文件末尾——
# install/dropins/asset 等平台端点先注册、优先匹配,不会被它遮蔽。
@router.api_route("/{plugin_id}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy_plugin_backend(plugin_id: str, path: str, request: Request) -> Response:
    body = await request.body()
    return plugin_runtime.proxy(plugin_id, "/" + path, request, body)
