from __future__ import annotations

import io
import posixpath

import pytest
from ftplib import error_perm

from app.ftp.service import FtpService, join_ftp_path, normalize_ftp_path
from app.core.errors import ValidationError


class FakeFtp:
    """最小内存 FTP：覆盖 FtpService 用到的 ftplib.FTP 接口。"""

    def __init__(self) -> None:
        # path -> {"kind": "dir"|"file", "content": bytes}
        self.nodes: dict[str, dict] = {"/": {"kind": "dir", "content": b""}}
        self._cwd = "/"

    # 连接相关
    def pwd(self) -> str:
        return self._cwd

    def cwd(self, path: str) -> str:
        target = self._resolve(path)
        if self.nodes.get(target, {}).get("kind") != "dir":
            raise error_perm("550 Not a directory")
        self._cwd = target
        return target

    def quit(self) -> None:
        return None

    def close(self) -> None:
        return None

    # 列目录
    def mlsd(self, path: str, facts: list[str]) -> list[tuple[str, dict[str, str]]]:
        target = self._resolve(path)
        if self.nodes.get(target, {}).get("kind") != "dir":
            raise error_perm("550 No such directory")
        items = []
        for child in self._children(target):
            node = self.nodes[child]
            meta = {"type": node["kind"]}
            if node["kind"] == "file":
                meta["size"] = str(len(node["content"]))
                meta["modify"] = "20260102030405"
            items.append((posixpath.basename(child), meta))
        return items

    def retrlines(self, command: str, callback) -> None:
        parts = command.split(None, 1)
        target = self._resolve(parts[1]) if len(parts) > 1 else self._cwd
        if self.nodes.get(target, {}).get("kind") != "dir":
            raise error_perm("550 No such directory")
        for child in self._children(target):
            node = self.nodes[child]
            name = posixpath.basename(child)
            if node["kind"] == "dir":
                callback(f"drwxr-xr-x 1 owner group 4096 Jan 02 2026 {name}")
            else:
                callback(f"-rw-r--r-- 1 owner group {len(node['content'])} Jan 02 2026 {name}")

    # 文件传输
    def retrbinary(self, command: str, callback) -> None:
        target = self._resolve(command.split(None, 1)[1])
        node = self.nodes.get(target)
        if node is None or node["kind"] != "file":
            raise error_perm("550 No such file")
        callback(node["content"])

    def storbinary(self, command: str, buffer: io.BytesIO) -> None:
        target = self._resolve(command.split(None, 1)[1])
        self.nodes[target] = {"kind": "file", "content": buffer.getvalue()}

    def mkd(self, path: str) -> str:
        target = self._resolve(path)
        if target in self.nodes:
            raise error_perm("550 Already exists")
        self.nodes[target] = {"kind": "dir", "content": b""}
        return target

    def rename(self, source: str, target: str) -> None:
        src = self._resolve(source)
        dst = self._resolve(target)
        if src not in self.nodes:
            raise error_perm("550 No such file")
        self.nodes[dst] = self.nodes.pop(src)

    def delete(self, path: str) -> None:
        target = self._resolve(path)
        node = self.nodes.get(target)
        if node is None or node["kind"] != "file":
            raise error_perm("550 No such file")
        del self.nodes[target]

    def rmd(self, path: str) -> None:
        target = self._resolve(path)
        node = self.nodes.get(target)
        if node is None or node["kind"] != "dir":
            raise error_perm("550 No such directory")
        if self._children(target):
            raise error_perm("550 Directory not empty")
        del self.nodes[target]

    # 内部
    def _resolve(self, path: str) -> str:
        if not path.startswith("/"):
            path = posixpath.join(self._cwd, path)
        return posixpath.normpath(path)

    def _children(self, target: str) -> list[str]:
        return sorted(
            child for child in self.nodes
            if child != "/" and posixpath.dirname(child) == target and child != target
        )


@pytest.fixture
def fake_ftp(monkeypatch):
    client = FakeFtp()
    monkeypatch.setattr(FtpService, "_connect", lambda self: client)
    return client


def configure(client, host="ftp.example.com"):
    response = client.put("/api/ftp/config", json={
        "host": host,
        "port": 21,
        "username": "user",
        "password": "secret",
        "passive": True,
        "encoding": "utf-8",
        "timeout_seconds": 10,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_config_roundtrip_masks_password(client):
    body = configure(client)
    assert body["password_configured"] is True
    assert "password" not in body

    fetched = client.get("/api/ftp/config").json()
    assert fetched["host"] == "ftp.example.com"
    assert fetched["username"] == "user"
    assert fetched["password_configured"] is True

    invalid = client.put("/api/ftp/config", json={"host": "h", "port": 21, "username": "u", "encoding": "no-such-codec", "timeout_seconds": 10})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_ftp_encoding"


def test_list_requires_configuration(client):
    response = client.get("/api/ftp/list", params={"path": "/"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "ftp_not_configured"


def test_list_upload_download_rename_delete(client, fake_ftp):
    configure(client)
    fake_ftp.mkd("/data")
    fake_ftp.storbinary("STOR /data/hello.txt", io.BytesIO("你好".encode("utf-8")))

    listed = client.get("/api/ftp/list", params={"path": "/data"})
    assert listed.status_code == 200, listed.text
    payload = listed.json()
    assert payload["path"] == "/data"
    assert [(item["name"], item["is_dir"]) for item in payload["entries"]] == [("hello.txt", False)]
    assert payload["entries"][0]["size"] == len("你好".encode("utf-8"))

    download = client.get("/api/ftp/download", params={"path": "/data/hello.txt"})
    assert download.status_code == 200
    assert download.content == "你好".encode("utf-8")
    assert "filename*=UTF-8''hello.txt" in download.headers["content-disposition"]

    missing = client.get("/api/ftp/download", params={"path": "/data/none.txt"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "ftp_file_not_found"

    upload = client.post(
        "/api/ftp/upload",
        data={"directory": "/data"},
        files={"files": ("上传.txt", b"uploads", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    assert upload.json()["uploaded"][0]["path"] == "/data/上传.txt"

    moved = client.post("/api/ftp/rename", json={"source": "/data/上传.txt", "target": "/data/renamed.txt"})
    assert moved.status_code == 200
    names = [item["name"] for item in client.get("/api/ftp/list", params={"path": "/data"}).json()["entries"]]
    assert sorted(names) == ["hello.txt", "renamed.txt"]

    removed = client.post("/api/ftp/delete", json={"path": "/data/renamed.txt"})
    assert removed.status_code == 200
    names = [item["name"] for item in client.get("/api/ftp/list", params={"path": "/data"}).json()["entries"]]
    assert names == ["hello.txt"]


def test_mkdir_and_recursive_delete(client, fake_ftp):
    configure(client)
    created = client.post("/api/ftp/mkdir", json={"path": "/datasets"})
    assert created.status_code == 200, created.text
    assert created.json()["is_dir"] is True

    client.post("/api/ftp/upload", data={"directory": "/datasets"}, files={"files": ("a.txt", b"aaa", "text/plain")})
    nested = client.post("/api/ftp/mkdir", json={"path": "/datasets/nested"})
    assert nested.status_code == 200
    client.post("/api/ftp/upload", data={"directory": "/datasets/nested"}, files={"files": ("b.txt", b"bbb", "text/plain")})

    removed = client.post("/api/ftp/delete", json={"path": "/datasets"})
    assert removed.status_code == 200
    entries = client.get("/api/ftp/list", params={"path": "/"}).json()["entries"]
    assert all(item["name"] != "datasets" for item in entries)


def test_test_connection_reports_failure(client, monkeypatch):
    from app.core.errors import ConflictError

    def broken_connect(self):
        raise ConflictError("ftp_connect_failed", "530 Login incorrect")

    monkeypatch.setattr(FtpService, "_connect", broken_connect)
    configure(client)
    response = client.post("/api/ftp/config/test")
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["code"] == "connect_failed"


def test_normalize_paths_rejects_control_characters():
    assert normalize_ftp_path("/a/../b") == "/b"
    assert normalize_ftp_path("") == "/"
    assert join_ftp_path("/data", "file.txt") == "/data/file.txt"
    with pytest.raises(ValidationError):
        normalize_ftp_path("/path\r\nNOOP")
    with pytest.raises(ValidationError):
        join_ftp_path("/data", "a/b")
    with pytest.raises(ValidationError):
        join_ftp_path("/data", "..")
    with pytest.raises(ValidationError):
        normalize_ftp_path("/", allow_root=False)


def test_list_falls_back_to_list_command(client, fake_ftp, monkeypatch):
    configure(client)

    def mlsd_unsupported(self, path, facts):
        raise error_perm("500 Unknown command")

    monkeypatch.setattr(FakeFtp, "mlsd", mlsd_unsupported)
    fake_ftp.storbinary("STOR /legacy.bin", io.BytesIO(b"12345"))

    payload = client.get("/api/ftp/list", params={"path": "/"}).json()
    entry = next(item for item in payload["entries"] if item["name"] == "legacy.bin")
    assert entry["is_dir"] is False
    assert entry["size"] == 5
    assert entry["modified"] == "Jan 02 2026"


def test_list_mlsd_lazy_501_falls_back(client, fake_ftp, monkeypatch):
    """真实 ftplib.FTP.mlsd 是生成器，OPTS MLST 的 501 要到迭代时才抛出。"""
    configure(client)

    def mlsd_lazy_501(self, path, facts):
        raise error_perm("501 Option not supported")
        yield  # 使其成为生成器，复现 ftplib 的惰性语义

    monkeypatch.setattr(FakeFtp, "mlsd", mlsd_lazy_501)
    fake_ftp.storbinary("STOR /lazy.bin", io.BytesIO(b"abc"))

    response = client.get("/api/ftp/list", params={"path": "/"})
    assert response.status_code == 200, response.text
    entry = next(item for item in response.json()["entries"] if item["name"] == "lazy.bin")
    assert entry["size"] == 3


def test_list_rejects_list_path_argument_falls_back_to_cwd(client, fake_ftp, monkeypatch):
    """个别服务器同时拒绝 OPTS MLST 与带路径参数的 LIST，应退回 CWD + 无参 LIST。"""
    configure(client)

    def mlsd_lazy_501(self, path, facts):
        raise error_perm("501 Option not supported")
        yield

    def retrlines(self, command: str, callback) -> None:
        if len(command.split()) > 1:
            raise error_perm("501 Option not supported")
        for child in self._children(self._cwd):
            node = self.nodes[child]
            name = posixpath.basename(child)
            if node["kind"] == "dir":
                callback(f"drwxr-xr-x 1 owner group 4096 Jan 02 2026 {name}")
            else:
                callback(f"-rw-r--r-- 1 owner group {len(node['content'])} Jan 02 2026 {name}")

    monkeypatch.setattr(FakeFtp, "mlsd", mlsd_lazy_501)
    monkeypatch.setattr(FakeFtp, "retrlines", retrlines)
    fake_ftp.storbinary("STOR /nested.bin", io.BytesIO(b"xy"))
    fake_ftp.mkd("/docs")

    response = client.get("/api/ftp/list", params={"path": "/"})
    assert response.status_code == 200, response.text
    entries = response.json()["entries"]
    assert any(item["name"] == "nested.bin" and item["size"] == 2 for item in entries)
    assert any(item["name"] == "docs" and item["is_dir"] for item in entries)


def test_list_directory_missing_returns_404(client, fake_ftp, monkeypatch):
    configure(client)

    def mlsd_lazy_501(self, path, facts):
        raise error_perm("501 Option not supported")
        yield

    monkeypatch.setattr(FakeFtp, "mlsd", mlsd_lazy_501)

    response = client.get("/api/ftp/list", params={"path": "/missing"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "ftp_dir_not_found"


def test_list_parses_windows_dos_listing(client, fake_ftp, monkeypatch):
    """IIS（Microsoft FTP Service）的 MS-DOS 风格列表：日期 时间 <DIR>/大小 名称。"""
    configure(client)

    def mlsd_lazy_501(self, path, facts):
        raise error_perm("501 Option not supported")
        yield

    def retrlines_dos(self, command, callback):
        callback("10-14-26  10:37AM       <DIR>          AnalyseData")
        callback("05-15-26  05:59PM          14072536064 ipp_inference_basic-runtime_V1.0.0_arm.tar.gz")
        callback("04-17-26  03:54PM            407944192 vsftpd linux tar.tar")
        callback("09-24-26  09:07AM       <DIR>          三峡算法备份")
        callback("12-30-25  12:00AM                   0 midnight.log")

    monkeypatch.setattr(FakeFtp, "mlsd", mlsd_lazy_501)
    monkeypatch.setattr(FakeFtp, "retrlines", retrlines_dos)

    response = client.get("/api/ftp/list", params={"path": "/"})
    assert response.status_code == 200, response.text
    entries = {item["name"]: item for item in response.json()["entries"]}
    assert entries["AnalyseData"]["is_dir"] is True
    assert entries["AnalyseData"]["size"] is None
    assert entries["AnalyseData"]["modified"] == "2026-10-14 10:37"
    assert entries["ipp_inference_basic-runtime_V1.0.0_arm.tar.gz"]["is_dir"] is False
    assert entries["ipp_inference_basic-runtime_V1.0.0_arm.tar.gz"]["size"] == 14072536064
    assert entries["ipp_inference_basic-runtime_V1.0.0_arm.tar.gz"]["modified"] == "2026-05-15 17:59"
    assert entries["vsftpd linux tar.tar"]["size"] == 407944192
    assert entries["三峡算法备份"]["is_dir"] is True
    assert entries["midnight.log"]["modified"] == "2025-12-30 00:00"


def test_fetch_directory_images_caps_and_reports_truncated(client, fake_ftp):
    configure(client)
    fake_ftp.mkd("/cam1")
    fake_ftp.mkd("/cam2")
    fake_ftp.storbinary("STOR /cam1/one.png", io.BytesIO(b"a"))
    fake_ftp.storbinary("STOR /cam1/two.png", io.BytesIO(b"b"))
    fake_ftp.storbinary("STOR /cam2/three.png", io.BytesIO(b"c"))

    service = FtpService(client.app.state.settings)

    seen: list[int] = []
    files, truncated = service.fetch_directory_images("/", recursive=True, max_bytes=50, max_files=2, on_progress=seen.append)
    assert len(files) == 2
    assert truncated is True
    assert seen == [1, 2]

    all_files, all_truncated = service.fetch_directory_images("/", recursive=True, max_bytes=50, max_files=5)
    assert [name for name, _ in all_files] == ["cam1/one.png", "cam1/two.png", "cam2/three.png"]
    assert all_truncated is False


def test_fetch_files_filters_and_downloads(client, fake_ftp):
    configure(client)
    fake_ftp.storbinary("STOR /pic.png", io.BytesIO(b"pngdata"))
    fake_ftp.storbinary("STOR /note.txt", io.BytesIO(b"text"))
    fake_ftp.storbinary("STOR /big.png", io.BytesIO(b"x" * 100))

    service = FtpService(client.app.state.settings)
    files, skipped = service.fetch_files(["/pic.png", "/note.txt", "/big.png", "/missing.png"], max_bytes=50)

    assert files == [("pic.png", b"pngdata")]
    assert skipped == 3
