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
