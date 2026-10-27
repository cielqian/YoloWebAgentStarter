"""插件机制:安装校验、列表、dropins 自动装载、静态资源服务与卸载。"""

from __future__ import annotations

import io
import json
import time
import zipfile

MANIFEST = {
    "id": "hello-demo",
    "name": "Hello 示例插件",
    "version": "1.0.0",
    "entry": "index.html",
    "description": "demo",
    "author": "tester",
    "icon": "🧩",
}
INDEX_HTML = "<!DOCTYPE html><html><body>hello plugin</body></html>"


def plugin_zip(manifest: dict = MANIFEST, index: str = INDEX_HTML, nested: bool = False) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        prefix = "pkg/" if nested else ""
        archive.writestr(f"{prefix}manifest.json", json.dumps(manifest))
        archive.writestr(f"{prefix}index.html", index)
        archive.writestr(f"{prefix}assets/app.js", "console.log(1)")
    return buffer.getvalue()


def test_install_list_serve_and_delete_plugin(client):
    installed = client.post(
        "/api/plugins/install",
        files={"file": ("hello-demo.zip", plugin_zip(), "application/zip")},
    )
    assert installed.status_code == 201, installed.text
    assert installed.json()["id"] == "hello-demo"

    listed = client.get("/api/plugins").json()
    assert [item["id"] for item in listed["items"]] == ["hello-demo"]
    assert "dropins" in listed["dropins_dir"]

    page = client.get("/api/plugins/hello-demo/asset/index.html")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    assert "hello plugin" in page.text
    script = client.get("/api/plugins/hello-demo/asset/assets/app.js")
    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]

    assert client.get("/api/plugins/hello-demo/asset/../../etc/passwd").status_code in (404, 422)
    assert client.get("/api/plugins/hello-demo/asset/missing.js").status_code == 404

    assert client.delete("/api/plugins/hello-demo").status_code == 204
    assert client.get("/api/plugins").json()["items"] == []


def test_install_rejects_invalid_manifest_and_missing_entry(client):
    bad_id = plugin_zip(manifest={**MANIFEST, "id": "Bad_ID"})
    response = client.post("/api/plugins/install", files={"file": ("a.zip", bad_id, "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "plugin_manifest_invalid"

    missing_entry = plugin_zip(manifest={**MANIFEST, "entry": "other.html"})
    response = client.post("/api/plugins/install", files={"file": ("a.zip", missing_entry, "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "plugin_entry_missing"

    no_manifest = io.BytesIO()
    with zipfile.ZipFile(no_manifest, "w") as archive:
        archive.writestr("index.html", INDEX_HTML)
    response = client.post("/api/plugins/install", files={"file": ("a.zip", no_manifest.getvalue(), "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "plugin_manifest_missing"


def test_install_rejects_unsafe_paths_and_accepts_nested_root(client):
    unsafe = io.BytesIO()
    with zipfile.ZipFile(unsafe, "w") as archive:
        archive.writestr("manifest.json", json.dumps(MANIFEST))
        archive.writestr("index.html", INDEX_HTML)
        archive.writestr("../escape.txt", "x")
    response = client.post("/api/plugins/install", files={"file": ("a.zip", unsafe.getvalue(), "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "plugin_zip_unsafe_path"

    nested = client.post("/api/plugins/install", files={"file": ("a.zip", plugin_zip(nested=True), "application/zip")})
    assert nested.status_code == 201, nested.text
    assert client.get("/api/plugins/hello-demo/asset/index.html").status_code == 200


def test_dropins_auto_scan_installs_zip(client):
    dropins = client.app.state.storage.data_dir / "plugins" / "dropins"
    dropins.mkdir(parents=True, exist_ok=True)
    (dropins / "hello-demo.zip").write_bytes(plugin_zip(manifest={**MANIFEST, "name": "Dropins 版"}))

    listed = client.get("/api/plugins").json()
    assert [item["name"] for item in listed["items"]] == ["Dropins 版"]

    # 再次列表不重复安装(mtime 幂等)
    again = client.get("/api/plugins").json()
    assert len(again["items"]) == 1
