"""算法服务部署:agent 侧 ServiceManager 与平台侧部署包模板的测试。

agent.py 以独立脚本形式运行,这里用 importlib 按路径加载做单元验证;
docker 相关路径依赖 docker 可用性,CI/无 docker 环境只跑校验与解压分支。
"""

from __future__ import annotations

import importlib.util
import io
import json
import shutil
import zipfile
from pathlib import Path

import pytest

AGENT_PATH = Path(__file__).resolve().parents[2] / "compute-agent" / "agent.py"

if not AGENT_PATH.is_file():
    pytest.skip("compute-agent/agent.py not found", allow_module_level=True)

_spec = importlib.util.spec_from_file_location("ywa_agent", AGENT_PATH)
agent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent)


@pytest.fixture
def manager(tmp_path: Path):
    return agent.ServiceManager(tmp_path / "svc")


def _ensure_pending(manager, service_id: str = "s1") -> None:
    """无 docker 环境下 create 会被 501 拦截,直接注入等价内存态继续测解压与状态。"""

    if service_id not in manager.services:
        try:
            manager.create({"service_id": service_id, "name": "crack-v3", "base_image": "img", "host_port": 8000, "start_cmd": "x"})
        except agent.TaskError as exc:
            assert exc.status == 501
            manager.services[service_id] = {
                "service_id": service_id, "spec": {"name": "crack-v3"}, "status": "pending",
                "error": None, "container_id": None, "created_at": 0, "started_at": None, "stopped_at": None,
            }
            manager.workspace(service_id).mkdir(parents=True, exist_ok=True)


def _zip_bytes(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def test_create_validates_spec(manager) -> None:
    for bad, code in [
        ({"service_id": "bad name"}, 400),
        ({}, 400),
        ({"service_id": "s2", "name": "ok", "base_image": "a;b", "host_port": 1, "start_cmd": "x"}, 400),
        ({"service_id": "s3", "name": "ok", "base_image": "img", "host_port": 0, "start_cmd": "x"}, 400),
        ({"service_id": "s4", "name": "ok", "base_image": "img", "host_port": 1, "start_cmd": "x", "gpu_device": "gpu0"}, 400),
        ({"service_id": "s5", "name": "ok", "base_image": "img", "host_port": 1, "start_cmd": "x", "restart_policy": "always!"}, 400),
    ]:
        with pytest.raises(agent.TaskError) as excinfo:
            manager.create(bad)
        assert excinfo.value.status == code, bad


def test_receive_package_extracts_and_blocks_traversal(manager, tmp_path: Path) -> None:
    _ensure_pending(manager)
    result = manager.receive_package("s1", _zip_bytes({"common_service_onnx/models/tag/pipeline.json": "{}", "app.py": "print('hi')"}))
    assert result["status"] == "ready"
    assert (manager.root / "s1" / "deploy" / "common_service_onnx" / "models" / "tag" / "pipeline.json").is_file()

    # ready 状态允许覆盖重传
    assert manager.receive_package("s1", _zip_bytes({"app.py": "print('v2')"}))["status"] == "ready"

    # 路径穿越被拒,状态落 failed
    with pytest.raises(agent.TaskError) as excinfo:
        manager.receive_package("s1", _zip_bytes({"../evil.txt": "x"}))
    assert excinfo.value.status == 400
    assert manager.status("s1")["status"] == "failed"


def test_load_existing_recovers_state(tmp_path: Path) -> None:
    root = tmp_path / "svc"
    first = agent.ServiceManager(root)
    _ensure_pending(first)
    # 手工落一个 deploying 中断的状态文件
    record = first.services["s1"]
    record["status"] = "deploying"
    first._persist("s1")

    second = agent.ServiceManager(root)
    second.load_existing()
    assert second.status("s1")["status"] == "failed"


def test_build_workspace_structure(tmp_path: Path) -> None:
    from app.algorithm_deploy.templates import build_workspace, class_name_for, remove_workspace, sanitize_tag

    assert sanitize_tag("Tower-Crack v3") == "ywa_tower_crack_v3"
    assert sanitize_tag("") == "ywa_model"
    assert class_name_for("ywa_crack_detect") == "YwaCrackDetect"

    source_root = tmp_path / "source"
    (source_root / "common_service_onnx" / "core").mkdir(parents=True)
    (source_root / "common_service_onnx" / "core" / "abstract_inference.py").write_text("class AbstractModelInferencer: pass\n", encoding="utf-8")
    (source_root / "common_service_onnx" / "__pycache__").mkdir(parents=True)
    (source_root / "common_service_onnx" / "__pycache__" / "junk.pyc").write_bytes(b"x")
    (source_root / "common_service_onnx" / "inferencer_mapping.json").write_text("{}", encoding="utf-8")
    model_src = tmp_path / "model.onnx"
    model_src.write_bytes(b"onnx-bytes")

    tag = sanitize_tag("yolo11n-crack")
    workspace = build_workspace(tmp_path / "deploy", source_root, tag, model_src, "onnx", ["裂缝", "锈蚀"], 0.25, 0.5, 1, 640)

    model_dir = workspace / "models" / tag
    assert (model_dir / "model.onnx").read_bytes() == b"onnx-bytes"
    inferencer_src = (model_dir / f"{tag}_inferencer.py").read_text(encoding="utf-8")
    assert "裂缝" in inferencer_src
    compile(inferencer_src, "inferencer.py", "exec")
    compile((model_dir / f"{tag}_response_builder.py").read_text(encoding="utf-8"), "builder.py", "exec")
    pipeline = json.loads((model_dir / "pipeline.json").read_text(encoding="utf-8"))
    entry = pipeline["inferencers"][0]
    assert entry["inference_class"] == class_name_for(tag)
    assert entry["models"][0]["classes"] == ["裂缝", "锈蚀"]
    assert entry["models"][0]["new_shape"] == [640, 640]
    mapping = json.loads((workspace / "inferencer_mapping.json").read_text(encoding="utf-8"))
    assert mapping[tag] == f"{tag}_pipeline"
    assert not (workspace / "__pycache__").exists()
    assert (tmp_path / "deploy" / "logs").is_dir()

    remove_workspace(tmp_path / "deploy")
    assert not (tmp_path / "deploy").exists()


def test_build_workspace_om_entry(tmp_path: Path) -> None:
    from app.algorithm_deploy.templates import build_workspace

    source_root = tmp_path / "source"
    (source_root / "common_service_onnx").mkdir(parents=True)
    (source_root / "common_service_onnx" / "inferencer_mapping.json").write_text("{}", encoding="utf-8")
    model_src = tmp_path / "model.om"
    model_src.write_bytes(b"om-bytes")
    workspace = build_workspace(tmp_path / "deploy", source_root, "ywa_om_model", model_src, "om", ["a"], 0.25, 0.5, 1, 640)
    entry = json.loads((workspace / "models" / "ywa_om_model" / "pipeline.json").read_text(encoding="utf-8"))["inferencers"][0]["models"][0]
    assert entry["om_path"] == "model.om"
    assert entry["path"] == "model.om"


def test_build_workspace_requires_source(tmp_path: Path) -> None:
    from app.algorithm_deploy.templates import build_workspace

    from app.core.errors import ValidationError

    with pytest.raises(ValidationError) as excinfo:
        build_workspace(tmp_path / "deploy", tmp_path / "empty", "tag", tmp_path / "m.onnx", "onnx", ["a"], 0.25, 0.5, 1, 640)
    assert excinfo.value.error_code == "algorithm_serving_code_missing"
