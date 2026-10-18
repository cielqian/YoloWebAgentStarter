from __future__ import annotations

import io
import posixpath
from datetime import datetime
from ftplib import FTP, error_perm, error_temp

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.storage import SUPPORTED_IMAGE_SUFFIXES
from app.ftp.schemas import FtpEntry, FtpListResult
from app.settings.schemas import FtpConnectionTestResult, FtpSettingsOut, FtpSettingsUpdate
from app.settings.service import SettingsService

# FTP 命令是行协议，路径里出现控制字符（尤其 \r\n）会被当作新命令注入。
_PATH_FORBIDDEN = set("\x00\r\n\t")


def normalize_ftp_path(path: str | None, *, allow_root: bool = True) -> str:
    raw = (path or "").strip()
    if not raw:
        raw = "/"
    if any(ch in _PATH_FORBIDDEN or ord(ch) < 32 for ch in raw):
        raise ValidationError("invalid_ftp_path", "FTP 路径包含非法字符。")
    normalized = posixpath.normpath(raw)
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    if not allow_root and normalized == "/":
        raise ValidationError("invalid_ftp_path", "路径不能是根目录。")
    return normalized


def join_ftp_path(directory: str, name: str) -> str:
    if not name or name in (".", "..") or "/" in name:
        raise ValidationError("invalid_ftp_path", "文件或目录名不合法。")
    return normalize_ftp_path(posixpath.join(directory, name), allow_root=False)


def _perm_code(exc: Exception) -> str:
    text = str(exc)
    for part in text.split():
        if part.isdigit():
            return part
    return ""


class FtpService:
    """FTP 文件管理：连接配置存 settings.json，操作走 ftplib。"""

    def __init__(self, settings: Settings) -> None:
        self._settings_service = SettingsService(settings)

    # --- 配置 ---

    def get_config(self) -> FtpSettingsOut:
        return self._settings_service.get_ftp_settings()

    def update_config(self, payload: FtpSettingsUpdate) -> FtpSettingsOut:
        return self._settings_service.update_ftp_settings(payload)

    def test_connection(self) -> FtpConnectionTestResult:
        try:
            with self._managed_client() as client:
                client.pwd()
        except ValidationError:
            raise
        except ConflictError as exc:
            return FtpConnectionTestResult(ok=False, message=exc.message, code="connect_failed")
        return FtpConnectionTestResult(ok=True, message="FTP 连接成功。", code="ok")

    # --- 文件操作 ---

    def list_dir(self, path: str | None) -> FtpListResult:
        target = normalize_ftp_path(path)
        with self._managed_client() as client:
            self._ensure_directory(client, target)
            entries = self._entries(client, target)
        entries.sort(key=lambda item: (not item.is_dir, item.name.lower()))
        return FtpListResult(path=target, entries=entries)

    def download(self, path: str) -> tuple[str, bytes]:
        target = normalize_ftp_path(path, allow_root=False)
        with self._managed_client() as client:
            buffer = io.BytesIO()
            try:
                client.retrbinary(f"RETR {target}", buffer.write)
            except error_perm as exc:
                if _perm_code(exc) == "550":
                    raise NotFoundError("ftp_file_not_found", "FTP 文件不存在或无权限访问。") from exc
                raise ConflictError("ftp_download_failed", f"下载失败：{exc}") from exc
        name = posixpath.basename(target) or "ftp_file"
        return name, buffer.getvalue()

    def fetch_directory_images(self, path: str, *, recursive: bool, max_bytes: int) -> list[tuple[str, bytes]]:
        """Collect readable image files under an FTP directory in one control session.

        Oversized or unreadable files are skipped so a single bad file cannot abort the sync.
        """
        root = normalize_ftp_path(path)
        collected: list[tuple[str, bytes]] = []
        with self._managed_client() as client:
            pending: list[tuple[str, str]] = [("", root)]
            while pending:
                relative, current = pending.pop(0)
                for entry in self._entries(client, current):
                    display = f"{relative}/{entry.name}" if relative else entry.name
                    if entry.is_dir:
                        if recursive:
                            pending.append((display, entry.path))
                        continue
                    if posixpath.splitext(entry.name)[1].lower() not in SUPPORTED_IMAGE_SUFFIXES:
                        continue
                    data = self._download_limited(client, entry.path, max_bytes)
                    if data is not None:
                        collected.append((display, data))
        return collected

    @staticmethod
    def _download_limited(client: FTP, path: str, max_bytes: int) -> bytes | None:
        class _TooLarge(Exception):
            pass

        buffer = io.BytesIO()
        total = 0

        def write(chunk: bytes) -> None:
            nonlocal total
            total += len(chunk)
            if total > max_bytes:
                raise _TooLarge()
            buffer.write(chunk)

        try:
            client.retrbinary(f"RETR {path}", write)
        except (_TooLarge, error_perm, error_temp):
            return None
        return buffer.getvalue()

    def upload(self, directory: str, file_name: str, data: bytes) -> FtpEntry:
        target = join_ftp_path(directory, file_name)
        with self._managed_client() as client:
            self._ensure_directory(client, normalize_ftp_path(directory))
            try:
                client.storbinary(f"STOR {target}", io.BytesIO(data))
            except error_perm as exc:
                raise ConflictError("ftp_upload_failed", f"上传失败：{exc}") from exc
        return FtpEntry(name=file_name, path=target, is_dir=False, size=len(data))

    def mkdir(self, path: str) -> FtpEntry:
        target = normalize_ftp_path(path, allow_root=False)
        with self._managed_client() as client:
            try:
                created = client.mkd(target) or target
            except error_perm as exc:
                raise ConflictError("ftp_mkdir_failed", f"创建目录失败：{exc}") from exc
        return FtpEntry(name=posixpath.basename(created) or created, path=normalize_ftp_path(created, allow_root=False), is_dir=True)

    def rename(self, source: str, target: str) -> None:
        src = normalize_ftp_path(source, allow_root=False)
        dst = normalize_ftp_path(target, allow_root=False)
        with self._managed_client() as client:
            try:
                client.rename(src, dst)
            except error_perm as exc:
                if _perm_code(exc) == "550":
                    raise NotFoundError("ftp_file_not_found", "源路径不存在或无权限访问。") from exc
                raise ConflictError("ftp_rename_failed", f"移动/重命名失败：{exc}") from exc

    def delete(self, path: str) -> None:
        target = normalize_ftp_path(path, allow_root=False)
        with self._managed_client() as client:
            self._delete_recursive(client, target)

    # --- 连接与辅助 ---

    def _connect(self) -> FTP:
        config = self._settings_service.get_ftp_settings_internal()
        if not config.host:
            raise ValidationError("ftp_not_configured", "请先在设置中配置 FTP 连接。")
        try:
            client = FTP()
            client.encoding = config.encoding
            client.connect(config.host, config.port, timeout=config.timeout_seconds)
            client.login(config.username or "anonymous", config.password or "")
            client.set_pasv(config.passive)
        except (error_perm, error_temp, OSError, EOFError) as exc:
            raise ConflictError("ftp_connect_failed", f"FTP 连接失败：{exc}") from exc
        return client

    def _managed_client(self) -> "_ManagedFtp":
        client = self._connect()
        return _ManagedFtp(client)

    def _ensure_directory(self, client: FTP, path: str) -> None:
        saved = client.pwd()
        try:
            client.cwd(path)
        except error_perm as exc:
            raise NotFoundError("ftp_dir_not_found", "FTP 目录不存在或无权限访问。") from exc
        finally:
            client.cwd(saved)

    def _entries(self, client: FTP, path: str) -> list[FtpEntry]:
        mlsd = self._entries_mlsd(client, path)
        if mlsd is not None:
            return mlsd
        return self._entries_list(client, path)

    def _entries_mlsd(self, client: FTP, path: str) -> list[FtpEntry] | None:
        try:
            facts = client.mlsd(path=path, facts=["type", "size", "modify"])
        except error_perm:
            return None
        entries: list[FtpEntry] = []
        for name, meta in facts:
            if name in (".", ".."):
                continue
            kind = meta.get("type", "")
            if kind not in ("dir", "file"):
                continue
            size: int | None = None
            if kind == "file":
                try:
                    size = int(meta.get("size", "0") or 0)
                except ValueError:
                    size = None
            entries.append(FtpEntry(name=name, path=join_ftp_path(path, name), is_dir=kind == "dir", size=size, modified=self._parse_mlsd_time(meta.get("modify"))))
        return entries

    @staticmethod
    def _parse_mlsd_time(value: str | None) -> str | None:
        if not value:
            return None
        try:
            return datetime.strptime(value[:14], "%Y%m%d%H%M%S").strftime("%Y-%m-%d %H:%M")
        except ValueError:
            return None

    def _entries_list(self, client: FTP, path: str) -> list[FtpEntry]:
        """MLSD 不可用时的兜底：解析 Unix 风格 LIST 输出。"""
        lines: list[str] = []
        try:
            client.retrlines(f"LIST {path}", lines.append)
        except error_perm as exc:
            raise NotFoundError("ftp_dir_not_found", "FTP 目录不存在或无权限访问。") from exc
        entries: list[FtpEntry] = []
        for line in lines:
            parts = line.split(None, 8)
            if len(parts) < 9 or not line.startswith(("d", "-", "l")):
                continue
            name = parts[8].split(" -> ")[0]
            if name in (".", ".."):
                continue
            entries.append(FtpEntry(
                name=name,
                path=join_ftp_path(path, name),
                is_dir=line.startswith("d"),
                size=None if line.startswith("d") else _safe_int(parts[4]),
                modified=" ".join(parts[5:8]) or None,
            ))
        return entries

    def _delete_recursive(self, client: FTP, path: str) -> None:
        saved = client.pwd()
        try:
            client.cwd(path)
        except error_perm:
            try:
                client.delete(path)
            except error_perm as exc:
                if _perm_code(exc) == "550":
                    raise NotFoundError("ftp_file_not_found", "FTP 路径不存在或无权限访问。") from exc
                raise ConflictError("ftp_delete_failed", f"删除失败：{exc}") from exc
            return
        finally:
            client.cwd(saved)
        for entry in self._entries(client, path):
            self._delete_recursive(client, entry.path)
        try:
            client.rmd(path)
        except error_perm as exc:
            raise ConflictError("ftp_delete_failed", f"删除目录失败：{exc}") from exc


def _safe_int(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class _ManagedFtp:
    """ftplib.FTP 没有上下文管理器，这里保证异常时也断开连接。"""

    def __init__(self, client: FTP) -> None:
        self._client = client

    def __enter__(self) -> FTP:
        return self._client

    def __exit__(self, *args: object) -> bool:
        try:
            self._client.quit()
        except Exception:
            self._client.close()
        return False


__all__ = ["FtpService", "normalize_ftp_path", "join_ftp_path"]
