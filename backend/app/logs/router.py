from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse

from app.api.dependencies import get_settings
from app.core.config import Settings
from app.logs.schemas import PluginLogListResponse, RuntimeLogResponse
from app.logs.service import list_plugin_logs, plugin_log_file, read_plugin_log, read_runtime_logs


router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("/runtime", response_model=RuntimeLogResponse)
def runtime_logs(
    lines: int = Query(default=300, ge=1, le=1000),
    level: str | None = Query(default=None, min_length=1, max_length=16),
    settings: Settings = Depends(get_settings),
) -> RuntimeLogResponse:
    return read_runtime_logs(settings, lines=lines, level=level)


@router.get("/plugins", response_model=PluginLogListResponse)
def plugin_logs(settings: Settings = Depends(get_settings)) -> PluginLogListResponse:
    """有运行日志的后端插件列表(插件子进程输出)。"""
    return PluginLogListResponse(items=list_plugin_logs(settings))


@router.get("/plugins/{plugin_id}", response_model=RuntimeLogResponse)
def plugin_log_tail(
    plugin_id: str,
    lines: int = Query(default=300, ge=1, le=1000),
    settings: Settings = Depends(get_settings),
) -> RuntimeLogResponse:
    return read_plugin_log(settings, plugin_id, lines=lines)


@router.get("/plugins/{plugin_id}/download")
def download_plugin_log(plugin_id: str, settings: Settings = Depends(get_settings)) -> FileResponse:
    path = plugin_log_file(settings, plugin_id)
    return FileResponse(path, media_type="text/plain; charset=utf-8", filename=f"{plugin_id}_runner.log")
