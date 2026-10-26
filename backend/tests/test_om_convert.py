"""OM 转换端到端：真实 agent 子进程 + 假 atc 脚本，验证路由与服务全链路。"""

from __future__ import annotations

import httpx
import os
import shutil
import socket
import subprocess
import sys
import time

from pathlib import Path

import pytest

from app.core.models import ModelVersion

AGENT_SOURCE = Path(__file__).resolve().parents[2] / "compute-agent" / "agent.py"


@pytest.fixture(autouse=True)
def _clear_om_jobs():
    from app.models import om_convert

    om_convert._jobs.clear()
    yield
    om_convert._jobs.clear()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class AgentProcess:
    def __init__(self, tmp_path: Path, *, with_atc: bool, cann_root: Path | None = None) -> None:
        self.port = _free_port()
        home = tmp_path / f"agent-{self.port}"
        home.mkdir(parents=True)
        shutil.copy2(AGENT_SOURCE, home / "agent.py")
        env = {**os.environ}
        if cann_root is not None:
            env["YWA_CANN_ROOT"] = str(cann_root)
        if with_atc:
            bin_dir = home / "bin"
            bin_dir.mkdir()
            atc = bin_dir / "atc"
            atc.write_text('#!/bin/sh\ncp input.onnx model.om\necho "ATC: fake convert success"\n')
            atc.chmod(0o755)
            env["PATH"] = f"{bin_dir}{os.pathsep}{env.get('PATH', '')}"
        self.process = subprocess.Popen(
            [sys.executable, str(home / "agent.py"), "--host", "127.0.0.1", "--port", str(self.port)],
            env=env,
            cwd=home,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def wait_healthy(self, timeout: float = 20.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                response = httpx.get(f"{self.url}/health", timeout=2)
                if response.status_code == 200:
                    return response.json()
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise RuntimeError("agent did not become healthy")

    def stop(self) -> None:
        self.process.terminate()
        self.process.wait(timeout=10)


def _make_onnx_model(client, model_id: str = "model_src1") -> tuple[str, bytes]:
    storage = client.app.state.storage
    payload = b"fake onnx payload"
    path = storage.model_version_dir(model_id) / "model.onnx"
    path.write_bytes(payload)
    with client.app.state.database.session_factory() as session:
        session.add(
            ModelVersion(
                id=model_id,
                name=f"{model_id}.onnx",
                version="v1",
                source="exported",
                artifact_type="onnx",
                format="onnx",
                task_type="detect",
                engine_type="ultralytics",
                model_path=str(path),
                status="active",
                metrics_json={},
                notes="",
            )
        )
        session.commit()
    return model_id, payload


def _wait_for_model_row(client, model_id: str, timeout: float = 90.0) -> dict:
    """轮询模型列表中 OM 记录行的状态，模拟前端展示进度的行为。"""
    target = f"model_{model_id}_om"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = client.get(f"/api/models/{target}")
        if row.status_code == 200 and row.json()["status"] in ("active", "archived", "failed"):
            return row.json()
        time.sleep(1)
    raise AssertionError("om model row did not reach terminal status in time")


def _register_node(client, url: str) -> dict:
    response = client.post("/api/om-convert/nodes", json={"name": "ascend-test", "url": url})
    assert response.status_code == 201, response.text
    return response.json()


def test_om_convert_end_to_end(client, tmp_path):
    model_id, payload = _make_onnx_model(client)
    agent = AgentProcess(tmp_path, with_atc=True)
    try:
        health = agent.wait_healthy()
        assert health["convert_supported"] is True
        node = _register_node(client, agent.url)

        submitted = client.post(
            f"/api/models/{model_id}/convert-om",
            json={"node_id": node["id"], "soc_version": "Ascend310P3", "input_shape": "images:1,3,640,640"},
        )
        assert submitted.status_code == 202, submitted.text
        job = submitted.json()
        assert job["result_model_id"]
        row = client.get(f"/api/models/{job['result_model_id']}")
        assert row.status_code == 200
        assert row.json()["status"] == "converting"  # 提交即建行，列表可见进度

        result = _wait_for_model_row(client, model_id)
        assert result["status"] == "active", result
        assert result["format"] == "om"
        assert result["artifact_type"] == "om"
        assert result["name"].endswith(".om")
        download = client.get(f"/api/models/{result['id']}/download")
        assert download.status_code == 200
        assert download.content == payload

        # 转换完成后 agent 侧任务应被清理
        leftover = httpx.get(f"{agent.url}/convert/ywa_{job['job_id']}")
        assert leftover.status_code == 404
    finally:
        agent.stop()


def test_om_convert_rejected_when_atc_missing(client, tmp_path):
    model_id, _ = _make_onnx_model(client, "model_src2")
    agent = AgentProcess(tmp_path, with_atc=False)
    try:
        health = agent.wait_healthy()
        assert health["convert_supported"] is False
        node = _register_node(client, agent.url)
        response = client.post(f"/api/models/{model_id}/convert-om", json={"node_id": node["id"]})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "atc_unavailable"
        assert client.get(f"/api/models/model_{model_id}_om").status_code == 404
    finally:
        agent.stop()


def test_om_convert_rejects_non_onnx_model(client, tmp_path):
    model_id, _ = _make_onnx_model(client, "model_src3")
    response = client.post(f"/api/models/{model_id}/convert-om", json={"node_id": "node_missing"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "training_node_not_found"


def test_om_convert_runs_atc_inside_venv_via_cann_env(client, tmp_path):
    """atc 不在 PATH 时：自动创建 venv + source CANN set_env.sh 后执行 atc。"""
    cann_root = tmp_path / "Ascend"
    toolkit = cann_root / "ascend-toolkit"
    toolkit.mkdir(parents=True)
    bin_dir = tmp_path / "fake-atc-bin"
    bin_dir.mkdir()
    atc = bin_dir / "atc"
    atc.write_text('#!/bin/sh\nprintf "VIRTUAL_ENV=%s\\n" "$VIRTUAL_ENV" > model.om\ncat input.onnx >> model.om\n')
    atc.chmod(0o755)
    (toolkit / "set_env.sh").write_text(f'export PATH="{bin_dir}:$PATH"\n')

    model_id, payload = _make_onnx_model(client, "model_src4")
    agent = AgentProcess(tmp_path, with_atc=False, cann_root=cann_root)
    try:
        health = agent.wait_healthy()
        assert health["convert_supported"] is True
        node = _register_node(client, agent.url)
        submitted = client.post(f"/api/models/{model_id}/convert-om", json={"node_id": node["id"]})
        assert submitted.status_code == 202, submitted.text
        result = _wait_for_model_row(client, model_id)
        assert result["status"] == "active", result
        download = client.get(f"/api/models/{result['id']}/download")
        body = download.content.decode("utf-8", "replace")
        assert "/convert-workspace/venv" in body, body[:200]
        assert download.content.endswith(payload)
    finally:
        agent.stop()
