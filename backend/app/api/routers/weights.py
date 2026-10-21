from __future__ import annotations

import re
from datetime import datetime

from fastapi import APIRouter, Depends, File, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.dependencies import get_settings, get_storage
from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.storage import Storage

router = APIRouter(prefix="/weights", tags=["weights"])

_SAFE_WEIGHT_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class BaseWeightItem(BaseModel):
    name: str
    size_bytes: int
    updated_at: datetime


class BaseWeightList(BaseModel):
    items: list[BaseWeightItem]


def list_weights(storage: Storage) -> list[BaseWeightItem]:
    items = [
        BaseWeightItem(name=path.name, size_bytes=path.stat().st_size, updated_at=datetime.fromtimestamp(path.stat().st_mtime))
        for path in sorted(storage.weights_dir().glob("*.pt"))
        if path.is_file()
    ]
    return items


@router.get("", response_model=BaseWeightList)
def get_weights(storage: Storage = Depends(get_storage)) -> BaseWeightList:
    return BaseWeightList(items=list_weights(storage))


@router.post("", response_model=BaseWeightItem, status_code=201)
async def upload_weight(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
    storage: Storage = Depends(get_storage),
) -> BaseWeightItem:
    name = file.filename or ""
    if not _SAFE_WEIGHT_NAME.fullmatch(name) or not name.lower().endswith(".pt"):
        raise ValidationError("invalid_weight_name", "权重文件名仅支持字母数字、点、下划线、连字符，且以 .pt 结尾。")
    content = await file.read(settings.max_upload_bytes + 1)
    if len(content) > settings.max_upload_bytes:
        raise ValidationError("weight_too_large", f"权重文件超过 {settings.max_upload_bytes // (1024 * 1024)} MB 上限。")
    if not content:
        raise ValidationError("weight_empty", "权重文件为空。")
    destination = storage.weight_path(name)
    if destination.exists():
        raise ConflictError("weight_exists", f"基础权重 {name} 已存在，请先删除再上传。")
    destination.write_bytes(content)
    return BaseWeightItem(name=name, size_bytes=len(content), updated_at=datetime.now())


@router.delete("/{name}", status_code=204, response_class=Response, response_model=None)
def delete_weight(name: str, storage: Storage = Depends(get_storage)) -> None:
    if not _SAFE_WEIGHT_NAME.fullmatch(name):
        raise ValidationError("invalid_weight_name", "非法的权重文件名。")
    path = storage.weight_path(name)
    if not path.is_file():
        raise NotFoundError("weight_not_found", "基础权重不存在。")
    path.unlink()


@router.get("/file/{name}")
def download_weight(name: str, storage: Storage = Depends(get_storage)) -> FileResponse:
    """供训练 agent 回连拉取基础权重。"""
    if not _SAFE_WEIGHT_NAME.fullmatch(name):
        raise ValidationError("invalid_weight_name", "非法的权重文件名。")
    path = storage.weight_path(name)
    if not path.is_file():
        raise NotFoundError("weight_not_found", "基础权重不存在。")
    return FileResponse(path, media_type="application/octet-stream", filename=name)
