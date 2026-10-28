from __future__ import annotations

from pydantic import BaseModel


class RuntimeLogResponse(BaseModel):
    path: str
    level: str | None = None
    lines: list[str]


class PluginLogEntry(BaseModel):
    plugin_id: str
    name: str
    size_bytes: int
    modified_at: str


class PluginLogListResponse(BaseModel):
    items: list[PluginLogEntry]
