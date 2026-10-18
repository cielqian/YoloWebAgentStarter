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
        target = self._resolve(command.split(None, 1)[1])
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
