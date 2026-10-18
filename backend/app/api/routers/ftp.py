from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile

from app.api.dependencies import get_settings
from app.core.config import Settings
from app.core.errors import ValidationError
from app.ftp.schemas import FtpEntry, FtpListResult, FtpPathRequest, FtpRenameRequest, FtpSettingsOut, FtpSettingsUpdate, FtpUploadResult
from app.ftp.service import FtpService
from app.settings.schemas import FtpConnectionTestResult

router = APIRouter(prefix="/ftp", tags=["ftp"])


def _service(settings: Settings) -> FtpService:
    return FtpService(settings)


@router.get("/config", response_model=FtpSettingsOut)
def get_ftp_config(settings: Settings = Depends(get_settings)) -> FtpSettingsOut:
    return _service(settings).get_config()


@router.put("/config", response_model=FtpSettingsOut)
def update_ftp_config(payload: FtpSettingsUpdate, settings: Settings = Depends(get_settings)) -> FtpSettingsOut:
    return _service(settings).update_config(payload)


@router.post("/config/test", response_model=FtpConnectionTestResult)
def test_ftp_config(settings: Settings = Depends(get_settings)) -> FtpConnectionTestResult:
    return _service(settings).test_connection()


@router.get("/list", response_model=FtpListResult)
def list_ftp_dir(path: str | None = None, settings: Settings = Depends(get_settings)) -> FtpListResult:
    return _service(settings).list_dir(path)


@router.get("/download")
def download_ftp_file(path: str, settings: Settings = Depends(get_settings)) -> Response:
    name, content = _service(settings).download(path)
    return Response(
        content=content,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


@router.post("/upload", response_model=FtpUploadResult)
async def upload_ftp_files(
    directory: str = Form(...),
    files: list[UploadFile] = File(...),
    settings: Settings = Depends(get_settings),
) -> FtpUploadResult:
    service = _service(settings)
    uploaded = []
    for file in files:
        content = await file.read(settings.max_upload_bytes + 1)
        if len(content) > settings.max_upload_bytes:
            raise ValidationError("upload_too_large", f"{file.filename} exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit.")
        uploaded.append(service.upload(directory, file.filename or "unnamed", content))
    return FtpUploadResult(uploaded=uploaded)


@router.post("/mkdir", response_model=FtpEntry)
def ftp_mkdir(payload: FtpPathRequest, settings: Settings = Depends(get_settings)) -> FtpEntry:
    return _service(settings).mkdir(payload.path)


@router.post("/rename")
def ftp_rename(payload: FtpRenameRequest, settings: Settings = Depends(get_settings)) -> dict:
    _service(settings).rename(payload.source, payload.target)
    return {"ok": True}


@router.post("/delete")
def ftp_delete(payload: FtpPathRequest, settings: Settings = Depends(get_settings)) -> dict:
    _service(settings).delete(payload.path)
    return {"ok": True}
