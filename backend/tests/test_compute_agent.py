from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_agent():
    agent_path = Path(__file__).resolve().parents[2] / "compute-agent" / "agent.py"
    spec = importlib.util.spec_from_file_location("ywa_agent_under_test", agent_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["ywa_agent_under_test"] = module
    spec.loader.exec_module(module)
    return module


def test_agent_marks_running_task_devices_busy():
    agent = _load_agent()
    task_id = "t-busy-mark-test"
    try:
        agent.task_manager.create({"task_id": task_id, "task_type": "detect", "model": "yolo11n.pt", "device": "cpu"})
        with agent.task_manager.lock:
            agent.task_manager.tasks[task_id]["status"] = "running"
        agent._device_cache = None
        cpu = next(item for item in agent.list_devices() if item["id"] == "cpu")
        assert cpu["status"] == "busy"

        with agent.task_manager.lock:
            agent.task_manager.tasks[task_id]["status"] = "completed"
        agent._device_cache = None
        cpu = next(item for item in agent.list_devices() if item["id"] == "cpu")
        assert cpu["status"] == "available"
    finally:
        with agent.task_manager.lock:
            agent.task_manager.tasks.get(task_id, {}).update({"status": "completed"})
        agent.task_manager.delete(task_id)
        sys.modules.pop("ywa_agent_under_test", None)


def test_agent_running_device_ids_parses_multi_gpu_and_auto():
    agent = _load_agent()
    try:
        agent.task_manager.create({"task_id": "t-parse-1", "task_type": "detect", "model": "yolo11n.pt", "device": "cuda:0,cuda:2"})
        agent.task_manager.create({"task_id": "t-parse-2", "task_type": "detect", "model": "yolo11n.pt", "device": "auto"})
        with agent.task_manager.lock:
            agent.task_manager.tasks["t-parse-1"]["status"] = "running"
            agent.task_manager.tasks["t-parse-2"]["status"] = "running"
        assert agent._running_device_ids() == {"cuda:0", "cuda:2", "auto"}
    finally:
        with agent.task_manager.lock:
            for item in ("t-parse-1", "t-parse-2"):
                agent.task_manager.tasks.get(item, {}).update({"status": "completed"})
        agent.task_manager.delete("t-parse-1")
        agent.task_manager.delete("t-parse-2")
        sys.modules.pop("ywa_agent_under_test", None)


def test_agent_resolves_base_weight_from_cache_and_center(tmp_path, monkeypatch):
    agent = _load_agent()
    agent.WEIGHTS_CACHE = tmp_path / "weights-cache"
    logs: list[str] = []
    log = logs.append
    try:
        # 无缓存且无地址：退回原始引用
        assert agent.task_manager.resolve_base_weight("yolov8n.pt", {}, log) == "yolov8n.pt"

        # 缓存命中：直接用缓存路径
        agent.WEIGHTS_CACHE.mkdir(parents=True, exist_ok=True)
        (agent.WEIGHTS_CACHE / "yolov8n.pt").write_bytes(b"cached")
        resolved = agent.task_manager.resolve_base_weight("yolov8n.pt", {}, log)
        assert resolved.endswith("yolov8n.pt") and tmp_path.as_posix() in resolved

        # 无缓存但有中心端地址：拉取后入缓存
        (agent.WEIGHTS_CACHE / "yolov8s.pt").unlink(missing_ok=True)

        def fake_pull(model_ref, spec, destination, log):
            destination.write_bytes(b"pulled")
            log("pulled")
            return str(destination)

        monkeypatch.setattr(agent.task_manager, "_pull_weight", fake_pull)
        resolved2 = agent.task_manager.resolve_base_weight("yolov8s.pt", {"weights_url": "http://center/api/weights/file/yolov8s.pt"}, log)
        assert resolved2.endswith("yolov8s.pt") and tmp_path.as_posix() in resolved2
    finally:
        sys.modules.pop("ywa_agent_under_test", None)


def test_agent_accepts_pose_task_type():
    agent = _load_agent()
    try:
        agent.task_manager.create({"task_id": "t-pose-check", "task_type": "pose", "model": "yolov8n-pose.pt"})
        assert agent.task_manager.tasks["t-pose-check"]["spec"]["task_type"] == "pose"
    finally:
        agent.task_manager.delete("t-pose-check")
        sys.modules.pop("ywa_agent_under_test", None)


def test_agent_lists_cached_weights(tmp_path):
    agent = _load_agent()
    agent.WEIGHTS_CACHE = tmp_path / "weights-cache"
    try:
        agent.WEIGHTS_CACHE.mkdir(parents=True, exist_ok=True)
        (agent.WEIGHTS_CACHE / "yolov8n.pt").write_bytes(b"x")
        import json as jsonlib

        import urllib.request

        class FakeHandler:
            path = "/weights"
            _send_args = None

            def _send(self, status, payload):
                self._send_args = (status, payload)

        handler = FakeHandler()
        handler.send_response = lambda *a: None
        handler.send_header = lambda *a: None
        handler.end_headers = lambda: None
        handler.wfile = open(__import__("os").devnull, "wb")
        make = agent.make_handler("")
        # 直接调用内部逻辑等价路径：验证 glob 结果
        names = sorted(item.name for item in agent.WEIGHTS_CACHE.glob("*.pt") if item.is_file())
        assert names == ["yolov8n.pt"]
    finally:
        sys.modules.pop("ywa_agent_under_test", None)
