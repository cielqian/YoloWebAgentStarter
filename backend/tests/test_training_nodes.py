from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from app.training.runtime import remote_nodes


AGENT_SNAPSHOT = {
    "agent": "ywa-compute-agent",
    "version": "0.1.0",
    "hostname": "gpu-server-01",
    "devices": [
        {"id": "cpu", "type": "cpu", "name": "EPYC", "index": None, "memory_total_mb": None, "memory_free_mb": None, "status": "available"},
        {"id": "cuda:0", "type": "cuda", "name": "RTX 4090", "index": 0, "memory_total_mb": 24564, "memory_free_mb": 23000, "status": "available"},
        {"id": "npu:0", "type": "npu", "name": "Ascend 310P3", "index": 0, "memory_total_mb": 24576, "memory_free_mb": None, "status": "available"},
    ],
}


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(
        project_root=Path(__file__).resolve().parents[2],
        data_dir=tmp_path / "data",
        import_root=tmp_path / "imports",
        database_url=f"sqlite:///{tmp_path / 'starter.db'}",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def add_node(client: TestClient, url: str = "http://gpu-01:8010", name: str = "gpu-01") -> dict:
    response = client.post("/api/training/nodes", json={"name": name, "url": url, "token": "secret", "enabled": True})
    assert response.status_code == 201, response.text
    return response.json()


def test_node_crud_roundtrip(client: TestClient):
    assert client.get("/api/training/nodes").json() == []
    node = add_node(client)
    assert node["name"] == "gpu-01"
    assert node["token_configured"] is True
    assert "token" not in node

    # 同地址不能重复注册
    duplicate = client.post("/api/training/nodes", json={"name": "again", "url": "http://gpu-01:8010/"})
    assert duplicate.status_code == 409, duplicate.text

    # 非法地址直接被拒
    invalid = client.post("/api/training/nodes", json={"name": "bad", "url": "ftp://x"})
    assert invalid.status_code == 422, invalid.text
    assert "http" in invalid.json()["error"]["message"]

    listed = client.get("/api/training/nodes").json()
    assert [item["id"] for item in listed] == [node["id"]]

    assert client.delete(f"/api/training/nodes/{node['id']}").status_code == 204
    assert client.get("/api/training/nodes").json() == []
    assert client.delete(f"/api/training/nodes/{node['id']}").status_code == 404


def test_node_test_endpoint_reports_agent_summary(client: TestClient, monkeypatch):
    from app.api.routers import training as training_router

    monkeypatch.setattr(training_router, "probe_node", lambda url, token, timeout=3.0: {
        "ok": True, "message": "连接成功", "hostname": "gpu-server-01",
        "device_count": 3, "device_types": ["cpu", "cuda", "npu"],
    })
    result = client.post("/api/training/nodes/test", json={"url": "http://gpu-01:8010", "token": "secret"}).json()
    assert result["ok"] is True
    assert result["hostname"] == "gpu-server-01"
    assert result["device_count"] == 3

    bad_url = client.post("/api/training/nodes/test", json={"url": "not-a-url"}).json()
    assert bad_url["ok"] is False


def test_devices_merge_remote_node(client: TestClient, monkeypatch):
    local_count = len(client.get("/api/training/devices").json()["items"])
    add_node(client)
    monkeypatch.setattr(remote_nodes, "fetch_node_snapshot", lambda url, token, timeout=3.0, use_cache=True: {"payload": AGENT_SNAPSHOT, "fetched_at": 0.0})

    body = client.get("/api/training/devices").json()
    remote_items = [item for item in body["items"] if item.get("node_id")]
    assert len(remote_items) == 3
    assert all(item["node_name"] == "gpu-01" for item in remote_items)
    npu = next(item for item in remote_items if item["type"] == "npu")
    assert npu["name"] == "Ascend 310P3"
    assert npu["memory_total_mb"] == 24576
    assert body["nodes"] == [{"id": body["nodes"][0]["id"], "name": "gpu-01", "url": "http://gpu-01:8010", "enabled": True, "status": "online", "device_count": 3, "error": None}]
    assert len(body["items"]) == local_count + 3


def test_devices_marks_offline_node(client: TestClient, monkeypatch):
    add_node(client)

    def unreachable(url, token, timeout=3.0, use_cache=True):
        raise remote_nodes.RemoteNodeUnavailable("连接失败：ConnectError")

    monkeypatch.setattr(remote_nodes, "fetch_node_snapshot", unreachable)
    body = client.get("/api/training/devices").json()
    assert [item for item in body["items"] if item.get("node_id")] == []
    assert body["nodes"][0]["status"] == "offline"
    assert "连接失败" in body["nodes"][0]["error"]
