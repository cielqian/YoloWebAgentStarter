from __future__ import annotations

import re

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

PLUGIN_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


class PluginBackendConfig(BaseModel):
    """后端插件声明:入口 .py 模块须导出 create_router(ctx) -> APIRouter。"""

    entry: str = Field(min_length=1, max_length=255)

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: str) -> str:
        cleaned = value.strip().lstrip("/")
        if not cleaned or ".." in cleaned.split("/") or "\\" in cleaned or not cleaned.endswith(".py"):
            raise ValueError("backend.entry 必须是包内相对 .py 路径，不能包含 .. 或反斜杠。")
        return cleaned


class PluginManifest(BaseModel):
    """插件清单:zip 根目录 manifest.json 的结构契约。"""

    id: str = Field(min_length=2, max_length=64)
    name: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=32)
    entry: str = Field(default="index.html", min_length=1, max_length=255)
    backend: PluginBackendConfig | None = None
    description: str | None = Field(default=None, max_length=2000)
    author: str | None = Field(default=None, max_length=100)
    icon: str | None = Field(default=None, max_length=8)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not PLUGIN_ID_PATTERN.fullmatch(value):
            raise ValueError("插件 id 只能包含小写字母、数字与连字符，且以字母或数字开头，长度 2-64。")
        return value

    @field_validator("version")
    @classmethod
    def validate_version(cls, value: str) -> str:
        if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", value):
            raise ValueError("version 必须是语义化版本号，例如 1.0.0 或 1.0.0-beta.1。")
        return value

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: str) -> str:
        cleaned = value.strip().lstrip("/")
        if not cleaned or ".." in cleaned.split("/") or "\\" in cleaned:
            raise ValueError("entry 必须是 zip 内的相对路径，不能包含 .. 或反斜杠。")
        return cleaned


class PluginOut(BaseModel):
    id: str
    name: str
    version: str
    entry: str
    backend: PluginBackendConfig | None = None
    has_backend: bool = False
    description: str | None = None
    author: str | None = None
    icon: str | None = None
    installed_at: datetime | None = None
