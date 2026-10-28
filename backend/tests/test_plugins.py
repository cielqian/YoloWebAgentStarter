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


def test_install_skips_macos_and_git_artifacts(client):
    finder = io.BytesIO()
    with zipfile.ZipFile(finder, "w") as archive:
        archive.writestr("pkg/manifest.json", json.dumps(MANIFEST))
        archive.writestr("pkg/index.html", INDEX_HTML)
        archive.writestr("__MACOSX/pkg/._manifest.json", "junk")
        archive.writestr("pkg/.DS_Store", "junk")
        archive.writestr("pkg/._index.html", "junk")
        archive.writestr("pkg/.git/config", "junk")
    response = client.post("/api/plugins/install", files={"file": ("a.zip", finder.getvalue(), "application/zip")})
    assert response.status_code == 201, response.text
    assert client.get("/api/plugins/hello-demo/asset/index.html").status_code == 200
    assert client.get("/api/plugins/hello-demo/asset/.DS_Store").status_code == 404
    assert client.get("/api/plugins/hello-demo/asset/._index.html").status_code == 404


def test_dropins_auto_scan_installs_zip(client):
    dropins = client.app.state.storage.data_dir / "plugins" / "dropins"
    dropins.mkdir(parents=True, exist_ok=True)
    (dropins / "hello-demo.zip").write_bytes(plugin_zip(manifest={**MANIFEST, "name": "Dropins 版"}))

    listed = client.get("/api/plugins").json()
    assert [item["name"] for item in listed["items"]] == ["Dropins 版"]

    # 再次列表不重复安装(mtime 幂等)
    again = client.get("/api/plugins").json()
    assert len(again["items"]) == 1


BACKEND_MAIN = '''
import json
from pathlib import Path
from fastapi import APIRouter

def create_router(ctx) -> APIRouter:
    router = APIRouter()

    @router.get("/ping")
    def ping():
        return {"ok": True, "plugin": ctx.plugin_id, "version": ctx.version}

    @router.get("/stats")
    def stats():
        with ctx.session_factory() as session:
            from sqlalchemy import text
            count = session.execute(text("SELECT COUNT(*) FROM datasets")).scalar()
        return {"datasets": count, "name": ctx.name}

    @router.post("/counter")
    def counter():
        state_file = ctx.data_dir / "counter.json"
        value = 0
        if state_file.is_file():
            value = json.loads(state_file.read_text(encoding="utf-8"))["value"]
        value += 1
        state_file.write_text(json.dumps({"value": value}), encoding="utf-8")
        ctx.logger.info("counter -> %s", value)
        return {"value": value}

    return router
'''


def backend_plugin_zip(plugin_id: str = "backend-demo", main_source: str = BACKEND_MAIN) -> bytes:
    manifest = {
        **MANIFEST,
        "id": plugin_id,
        "backend": {"entry": "server/main.py"},
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("index.html", INDEX_HTML)
        archive.writestr("server/main.py", main_source)
    return buffer.getvalue()


def test_backend_plugin_mounts_routes_and_unloads_on_delete(client):
    installed = client.post(
        "/api/plugins/install",
        files={"file": ("backend-demo.zip", backend_plugin_zip(), "application/zip")},
    )
    assert installed.status_code == 201, installed.text
    assert installed.json()["has_backend"] is True

    # 前端静态页与后端 API 同时可用
    assert client.get("/api/plugins/backend-demo/asset/index.html").status_code == 200
    ping = client.get("/api/plugins/backend-demo/ping")
    assert ping.status_code == 200, ping.text
    assert ping.json() == {"ok": True, "plugin": "backend-demo", "version": "1.0.0"}

    # ctx.session_factory 可访问平台数据库
    stats = client.get("/api/plugins/backend-demo/stats")
    assert stats.status_code == 200
    assert stats.json() == {"datasets": 0, "name": "Hello 示例插件"}

    # ctx.data_dir 私有目录持久化
    assert client.post("/api/plugins/backend-demo/counter").json() == {"value": 1}
    assert client.post("/api/plugins/backend-demo/counter").json() == {"value": 2}

    # 卸载后路由即时摘除
    assert client.delete("/api/plugins/backend-demo").status_code == 204
    assert client.get("/api/plugins/backend-demo/ping").status_code in (404, 405)


def test_backend_plugin_reinstall_hot_swaps_code(client):
    marker_v1 = BACKEND_MAIN.replace('"version": ctx.version', '"version": "custom-v1"')
    installed = client.post(
        "/api/plugins/install",
        files={"file": ("backend-demo.zip", backend_plugin_zip(main_source=marker_v1), "application/zip")},
    )
    assert installed.status_code == 201
    assert client.get("/api/plugins/backend-demo/ping").json()["version"] == "custom-v1"

    # 同 id 重装 = 覆盖升级,路由热切换到新代码
    marker_v2 = BACKEND_MAIN.replace('"version": ctx.version', '"version": "custom-v2"')
    upgraded = client.post(
        "/api/plugins/install",
        files={"file": ("backend-demo.zip", backend_plugin_zip(main_source=marker_v2), "application/zip")},
    )
    assert upgraded.status_code == 201
    assert client.get("/api/plugins/backend-demo/ping").json()["version"] == "custom-v2"


def test_install_rejects_broken_backend_and_rolls_back(client):
    broken = backend_plugin_zip(main_source="def create_router(ctx):\n    return 42\n")
    response = client.post("/api/plugins/install", files={"file": ("a.zip", broken, "application/zip")})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "plugin_backend_invalid"
    # 整体回滚:前端入口也不应存在
    assert client.get("/api/plugins/backend-demo/asset/index.html").status_code == 404
    assert client.get("/api/plugins/backend-demo/ping").status_code == 404

    syntax_error = backend_plugin_zip(main_source="def broken(:\n")
    response = client.post("/api/plugins/install", files={"file": ("a.zip", syntax_error, "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "plugin_backend_invalid"


def test_install_rejects_reserved_plugin_routes_and_ids(client):
    asset_route = BACKEND_MAIN.replace(
        "    return router",
        '    @router.get("/asset/leak")\n    def leak():\n        return {}\n\n    return router',
    )
    response = client.post("/api/plugins/install", files={"file": ("a.zip", backend_plugin_zip(main_source=asset_route), "application/zip")})
    assert response.status_code == 422, response.text
    assert "保留路径" in response.json()["error"]["message"]

    empty_route = BACKEND_MAIN.replace(
        "    return router",
        '    @router.get("")\n    def root():\n        return {}\n\n    return router',
    )
    response = client.post("/api/plugins/install", files={"file": ("a.zip", backend_plugin_zip(main_source=empty_route), "application/zip")})
    assert response.status_code == 422

    # dropins 是管理端点保留字,后端插件不允许占用该 id
    response = client.post("/api/plugins/install", files={"file": ("a.zip", backend_plugin_zip(plugin_id="dropins"), "application/zip")})
    assert response.status_code == 422
    assert "保留字" in response.json()["error"]["message"]
    assert client.get("/api/plugins/backend-demo/ping").status_code == 404


CRASH_MAIN = BACKEND_MAIN + '''


def _register_crash(router):
    @router.get("/boom")
    def boom():
        import os

        os._exit(9)  # 模拟插件进程崩溃
'''


def test_plugin_process_crash_never_affects_platform_and_self_heals(client, monkeypatch):
    monkeypatch.setenv("YWA_PLUGIN_RESTART_COOLDOWN", "0")
    crash_source = BACKEND_MAIN.replace(
        "    return router",
        '    @router.get("/boom")\n    def boom():\n        import os\n        os._exit(9)\n\n    return router',
    )
    installed = client.post(
        "/api/plugins/install",
        files={"file": ("backend-demo.zip", backend_plugin_zip(main_source=crash_source), "application/zip")},
    )
    assert installed.status_code == 201, installed.text

    # 插件子进程请求中自杀:代理层兜住,返回 503 而非拖垮平台
    boom = client.get("/api/plugins/backend-demo/boom")
    assert boom.status_code == 503

    # 平台核心接口全程健康
    assert client.get("/api/system/health").json()["status"] == "ok"
    assert client.get("/api/plugins").status_code == 200

    # 自愈:下一次请求自动重启子进程并恢复服务
    revived = client.get("/api/plugins/backend-demo/ping")
    assert revived.status_code == 200, revived.text
    assert revived.json()["ok"] is True

    assert client.delete("/api/plugins/backend-demo").status_code == 204


def test_plugin_runtime_logs_view_and_download(client):
    installed = client.post(
        "/api/plugins/install",
        files={"file": ("backend-demo.zip", backend_plugin_zip(), "application/zip")},
    )
    assert installed.status_code == 201, installed.text

    listed = client.get("/api/logs/plugins").json()["items"]
    entry = next((item for item in listed if item["plugin_id"] == "backend-demo"), None)
    assert entry is not None and entry["size_bytes"] > 0

    tail = client.get("/api/logs/plugins/backend-demo?lines=100")
    assert tail.status_code == 200, tail.text
    assert "runner.log" in tail.json()["path"]
    assert len(tail.json()["lines"]) > 0

    download = client.get("/api/logs/plugins/backend-demo/download")
    assert download.status_code == 200
    assert "attachment" in download.headers.get("content-disposition", "")
    assert "backend-demo_runner.log" in download.headers.get("content-disposition", "")
    assert len(download.text) > 0

    assert client.get("/api/logs/plugins/missing-plugin").status_code == 404

    # 卸载后日志保留,可做事后排查
    assert client.delete("/api/plugins/backend-demo").status_code == 204
    assert client.get("/api/logs/plugins/backend-demo/download").status_code == 200
