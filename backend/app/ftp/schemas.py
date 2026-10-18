from __future__ import annotations

from pydantic import BaseModel, Field

from app.settings.schemas import FtpSettingsOut, FtpSettingsUpdate


class FtpEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int | None = None
    modified: str | None = None


class FtpListResult(BaseModel):
    path: str
    entries: list[FtpEntry]


class FtpPathRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)


class FtpRenameRequest(BaseModel):
    source: str = Field(min_length=1, max_length=2048)
    target: str = Field(min_length=1, max_length=2048)


class FtpUploadResult(BaseModel):
    uploaded: list[FtpEntry]
