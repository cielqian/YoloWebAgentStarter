"""插件装载:zip 安装校验、dropins 目录自动扫描、静态资源服务。

插件是自包含的静态 Web 应用(任意技术栈构建)，解压到
<data>/plugins/<id>/ 后由宿主以 iframe 打开 entry 页面。
"""

from __future__ import annotations

import json
import re
import shutil
import zipfile

from datetime import datetime, timezone
from pathlib import Path

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.storage import Storage
from app.plugins.schemas import PLUGIN_ID_PATTERN, PluginManifest, PluginOut

MAX_ZIP_BYTES = 200 * 1024 * 1024
MAX_ENTRIES = 4000
MAX_MEMBER_BYTES = 64 * 1024 * 1024

_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
}


def plugins_root(storage: Storage) -> Path:
    root = storage.data_dir / "plugins"
    root.mkdir(parents=True, exist_ok=True)
    return root


def dropins_dir(storage: Storage) -> Path:
    directory = plugins_root(storage) / "dropins"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def plugin_dir(storage: Storage, plugin_id: str) -> Path:
    if not PLUGIN_ID_PATTERN.fullmatch(plugin_id):
        raise ValidationError("plugin_id_invalid", "插件 id 非法。")
    return plugins_root(storage) / plugin_id


def _clean_member(name: str) -> str | None:
    """zip 成员规整:归一分隔符、剥掉前导 /;返回 None 表示应静默忽略的杂项。

    忽略 .git,以及 macOS Finder 打包产生的 __MACOSX/、.DS_Store 与 ._* 资源分叉文件。
    """
    cleaned = name.replace("\\", "/").lstrip("/")
    if not cleaned:
        return None
    parts = [part for part in cleaned.split("/") if part not in ("", ".")]
    if not parts:
        return None
    if parts[0] in (".git", "__MACOSX"):
        return None
    if any(part == ".DS_Store" or part.startswith("._") for part in parts):
        return None
    return "/".join(parts)


def install_zip(storage: Storage, payload: bytes) -> PluginOut:
    if len(payload) > MAX_ZIP_BYTES:
        raise ValidationError("plugin_zip_too_large", f"插件包超过 {MAX_ZIP_BYTES // (1024 * 1024)} MB 上限。")
    try:
        archive = zipfile.ZipFile(__import__("io").BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise ValidationError("plugin_zip_invalid", "插件包不是有效的 zip 文件。") from exc

    members: dict[str, zipfile.ZipInfo] = {}
    total_uncompressed = 0
    for info in archive.infolist():
        if info.is_dir():
            continue
        safe = _clean_member(info.filename)
        if safe is None:
            continue
        if ".." in safe.split("/"):
            raise ValidationError("plugin_zip_unsafe_path", f"插件包含不安全的路径：{info.filename}")
        if len(members) >= MAX_ENTRIES:
            raise ValidationError("plugin_zip_too_many_files", f"插件包文件数超过 {MAX_ENTRIES}。")
        if info.file_size > MAX_MEMBER_BYTES:
            raise ValidationError("plugin_zip_member_too_large", f"单个文件超过上限：{info.filename}")
        total_uncompressed += info.file_size
        members[safe] = info
    if total_uncompressed > MAX_ZIP_BYTES:
        raise ValidationError("plugin_zip_too_large", "插件包解压后总大小超限。")

    manifest_name = "manifest.json" if "manifest.json" in members else None
    if manifest_name is None:
        # 允许 zip 内只有一层顶层目录包含 manifest.json
        top_levels = {name.split("/", 1)[0] for name in members}
        if len(top_levels) == 1:
            candidate = f"{next(iter(top_levels))}/manifest.json"
            if candidate in members:
                manifest_name = candidate
    if manifest_name is None:
        raise ValidationError("plugin_manifest_missing", "插件包根目录(或唯一顶层目录下)必须有 manifest.json。")

    try:
        manifest_raw = json.loads(archive.read(manifest_name).decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise ValidationError("plugin_manifest_invalid", "manifest.json 必须是 UTF-8 编码的合法 JSON。") from exc
    try:
        manifest = PluginManifest.model_validate(manifest_raw)
    except Exception as exc:  # noqa: BLE001 - pydantic 校验错误统一转 422
        raise ValidationError("plugin_manifest_invalid", f"manifest.json 校验失败：{exc}") from exc

    prefix = "" if manifest_name == "manifest.json" else manifest_name[: -len("manifest.json")]
    if f"{prefix}{manifest.entry}" not in members:
        raise ValidationError("plugin_entry_missing", f"入口文件 {manifest.entry} 不在插件包内。")

    target = plugin_dir(storage, manifest.id)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for safe, info in members.items():
        relative = safe[len(prefix):] if prefix and safe.startswith(prefix) else safe
        if not relative:
            continue
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(info) as source, destination.open("wb") as output:
            shutil.copyfileobj(source, output)
    return _read_installed(storage, manifest.id)


def _read_installed(storage: Storage, plugin_id: str) -> PluginOut:
    directory = plugin_dir(storage, plugin_id)
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        raise NotFoundError("plugin_not_found", "插件不存在。")
    try:
        manifest = PluginManifest.model_validate(json.loads(manifest_path.read_text(encoding="utf-8")))
    except Exception as exc:  # noqa: BLE001
        raise ConflictError("plugin_manifest_broken", f"插件 {plugin_id} 的 manifest.json 损坏：{exc}") from exc
    installed_at = datetime.fromtimestamp(manifest_path.stat().st_mtime, tz=timezone.utc)
    return PluginOut(**manifest.model_dump(), installed_at=installed_at)


def list_plugins(storage: Storage) -> list[PluginOut]:
    plugins: list[PluginOut] = []
    for directory in sorted(plugins_root(storage).iterdir()):
        if not directory.is_dir() or directory.name == "dropins":
            continue
        try:
            plugins.append(_read_installed(storage, directory.name))
        except (NotFoundError, ConflictError):
            continue
    return plugins


def delete_plugin(storage: Storage, plugin_id: str) -> None:
    directory = plugin_dir(storage, plugin_id)
    if not directory.is_dir():
        raise NotFoundError("plugin_not_found", "插件不存在。")
    shutil.rmtree(directory)


def scan_dropins(storage: Storage) -> list[PluginOut]:
    """把 dropins 目录里的 zip 自动安装/升级;按 dropins 目录 mtime 做幂等去重。"""
    marker = plugins_root(storage) / ".dropins-scan"
    directory = dropins_dir(storage)
    current_mtime = directory.stat().st_mtime
    if marker.is_file() and marker.read_text(encoding="utf-8").strip() == str(current_mtime):
        return []
    installed: list[PluginOut] = []
    errors: list[str] = []
    for zip_file in sorted(directory.glob("*.zip")):
        try:
            installed.append(install_zip(storage, zip_file.read_bytes()))
        except (ValidationError, ConflictError) as exc:
            errors.append(f"{zip_file.name}: {exc.message}")
    marker.write_text(str(current_mtime), encoding="utf-8")
    if errors:
        raise ConflictError("plugin_dropins_failed", "以下插件包安装失败：" + "；".join(errors))
    return installed


def resolve_asset(storage: Storage, plugin_id: str, relative_path: str) -> tuple[Path, str]:
    directory = plugin_dir(storage, plugin_id)
    candidate = (directory / relative_path).resolve()
    root = directory.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValidationError("plugin_asset_unsafe_path", "资源路径越界。")
    if not candidate.is_file():
        raise NotFoundError("plugin_asset_not_found", "插件资源不存在。")
    return candidate, _MIME_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
