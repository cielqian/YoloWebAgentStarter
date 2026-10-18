from __future__ import annotations

import io
import json

from PIL import Image


def png_bytes(size: tuple[int, int] = (60, 40)) -> bytes:
    image = Image.new("RGB", size, "#4477aa")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def create_dataset(client, task_type: str) -> str:
    response = client.post("/api/datasets", json={"name": "demo", "task_type": task_type})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def create_template(client, name: str, color: str = "#22c55e", sam3_prompt: str | None = None) -> dict:
    payload = {"name": name, "color": color}
    if sam3_prompt is not None:
        payload["sam3_prompt"] = sam3_prompt
    response = client.post("/api/class-templates", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_template_crud_and_default_translation(client):
    helmet = create_template(client, "安全帽", "#ef4444")
    assert helmet["sam3_prompt"] == "helmet"

    screen = create_template(client, "screen", "#3b82f6")
    assert screen["sam3_prompt"] == "screen"

    duplicate = client.post("/api/class-templates", json={"name": "安全帽", "color": "#22c55e"})
    assert duplicate.status_code == 409

    listed = client.get("/api/class-templates")
    assert listed.status_code == 200
    assert [item["name"] for item in listed.json()] == ["安全帽", "screen"]

    patched = client.patch(f"/api/class-templates/{helmet['id']}", json={"sam3_prompt": "hard hat"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["sam3_prompt"] == "hard hat"

    deleted = client.delete(f"/api/class-templates/{screen['id']}")
    assert deleted.status_code == 204
    assert all(item["id"] != screen["id"] for item in client.get("/api/class-templates").json())


def test_translate_endpoint_uses_dictionary_without_llm(client):
    known = client.post("/api/class-templates/translate", json={"name": "屏幕"})
    assert known.status_code == 200
    assert known.json()["sam3_prompt"] == "screen"
    assert known.json()["source"] == "dictionary"

    unknown = client.post("/api/class-templates/translate", json={"name": "未覆盖的词"})
    assert unknown.status_code == 200
    assert unknown.json()["sam3_prompt"] is None
    assert unknown.json()["source"] == "llm_unconfigured"


class _FakeLlmResponse:
    status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"choices": [{"message": {"content": "ferrite magnet"}}]}


class _FakeLlmClient:
    def __init__(self, **_kwargs) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> bool:
        return False

    def post(self, _url, json=None, headers=None):
        return _FakeLlmResponse()


def test_translate_uses_runtime_llm_settings(monkeypatch, client):
    # 设置页保存的 LLM 配置在 settings.json，而不是环境变量级 Settings.agent_*
    settings_file = client.app.state.settings.data_dir / "settings.json"
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    settings_file.write_text(json.dumps({
        "llm": {
            "enabled": True,
            "provider": "openai-compatible",
            "api_base": "http://127.0.0.1:9/v1",
            "api_key": "sk-test",
            "model": "test-model",
            "temperature": 0.2,
            "timeout_seconds": 5,
            "auth_scheme": "bearer",
            "auth_header_name": "",
        },
    }, ensure_ascii=False), encoding="utf-8")

    monkeypatch.setattr("app.class_library.translation.httpx.Client", lambda **kwargs: _FakeLlmClient())

    response = client.post("/api/class-templates/translate", json={"name": "磁铁"})
    assert response.status_code == 200
    assert response.json()["sam3_prompt"] == "ferrite magnet"
    assert response.json()["source"] == "llm"


def test_import_templates_into_segment_dataset(client):
    dataset_id = create_dataset(client, "segment")
    existing = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "screen", "color": "#999999"})
    assert existing.status_code == 201

    helmet = create_template(client, "安全帽", "#ef4444")
    screen = create_template(client, "screen", "#3b82f6")
    forklift = create_template(client, "叉车", "#f59e0b", sam3_prompt="forklift")

    response = client.post(
        f"/api/datasets/{dataset_id}/classes/import",
        json={"template_ids": [helmet["id"], screen["id"], forklift["id"]]},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["skipped_names"] == ["screen"]
    assert [(item["class_index"], item["name"], item["sam3_prompt"]) for item in payload["imported"]] == [
        (1, "安全帽", "helmet"),
        (2, "叉车", "forklift"),
    ]

    classes = client.get(f"/api/datasets/{dataset_id}/classes").json()
    assert [item["class_index"] for item in classes] == [0, 1, 2]


def test_import_templates_into_detect_dataset_drops_prompt(client):
    dataset_id = create_dataset(client, "detect")
    helmet = create_template(client, "安全帽", "#ef4444")

    response = client.post(f"/api/datasets/{dataset_id}/classes/import", json={"template_ids": [helmet["id"]]})
    assert response.status_code == 200, response.text
    assert [item["sam3_prompt"] for item in response.json()["imported"]] == [None]


def test_import_into_empty_dataset_starts_at_index_zero(client):
    dataset_id = create_dataset(client, "segment")
    helmet = create_template(client, "安全帽", "#ef4444")

    response = client.post(f"/api/datasets/{dataset_id}/classes/import", json={"template_ids": [helmet["id"]]})
    assert response.status_code == 200, response.text
    assert [item["class_index"] for item in response.json()["imported"]] == [0]


def test_class_prompt_updates_are_segment_only(client):
    segment_id = create_dataset(client, "segment")
    detect_id = create_dataset(client, "detect")

    created = client.post(f"/api/datasets/{segment_id}/classes", json={"name": "缺陷", "color": "#a855f7"})
    assert created.status_code == 201, created.text
    assert created.json()["sam3_prompt"] == "defect"
    segment_class_id = created.json()["id"]

    patched = client.patch(
        f"/api/datasets/{segment_id}/classes/{segment_class_id}",
        json={"sam3_prompt": "surface defect"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["sam3_prompt"] == "surface defect"

    detect_class = client.post(f"/api/datasets/{detect_id}/classes", json={"name": "缺陷", "color": "#a855f7"})
    assert detect_class.status_code == 201, detect_class.text
    assert detect_class.json()["sam3_prompt"] is None

    rejected = client.patch(
        f"/api/datasets/{detect_id}/classes/{detect_class.json()['id']}",
        json={"sam3_prompt": "defect"},
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "sam3_prompt_requires_segment"


def test_delete_unused_class_reindexes_remaining(client):
    dataset_id = create_dataset(client, "segment")
    names = ["cat", "dog", "bird", "fish", "horse"]
    created = []
    for name in names:
        response = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": name, "color": "#22c55e"})
        assert response.status_code == 201, response.text
        created.append(response.json())

    # 删中间类别触发剩余 4 个的 class_index 重排；主键顺序与 class_index 无关，
    # 曾因逐行 UPDATE 中间态撞 (dataset_id, class_index) 唯一约束而 500。
    deleted = client.delete(f"/api/datasets/{dataset_id}/classes/{created[2]['id']}")
    assert deleted.status_code == 204

    remaining = client.get(f"/api/datasets/{dataset_id}/classes").json()
    assert [(item["name"], item["class_index"]) for item in remaining] == [
        ("cat", 0), ("dog", 1), ("fish", 2), ("horse", 3),
    ]


def test_delete_class_used_by_annotation_is_rejected(client):
    dataset_id = create_dataset(client, "detect")
    created = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat", "color": "#22c55e"})
    class_id = created.json()["id"]
    upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("cat.png", png_bytes(), "image/png")},
    )
    image_id = upload.json()["items"][0]["id"]
    saved = client.put(
        f"/api/datasets/{dataset_id}/images/{image_id}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": 1, "y": 1, "width": 5, "height": 5}}]},
    )
    assert saved.status_code == 200, saved.text

    rejected = client.delete(f"/api/datasets/{dataset_id}/classes/{class_id}")
    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "class_in_use"
