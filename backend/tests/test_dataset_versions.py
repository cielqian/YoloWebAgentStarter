from __future__ import annotations

import io

from PIL import Image


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (100, 80)) -> bytes:
    image = Image.new("RGB", size, color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def create_dataset(client, task_type: str = "detect") -> str:
    response = client.post("/api/datasets", json={"name": "demo", "task_type": task_type})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def upload_image(client, dataset_id: str, name: str = "cat.png") -> dict:
    response = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": (name, png_bytes(), "image/png")},
    )
    assert response.status_code == 201, response.text
    return response.json()["items"][0]


def save_bbox(client, dataset_id: str, image_id: str, class_id: str, x: float = 10) -> None:
    response = client.put(
        f"/api/datasets/{dataset_id}/images/{image_id}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": x, "y": 12, "width": 30, "height": 25}}]},
    )
    assert response.status_code == 200, response.text


def annotations_of(client, dataset_id: str, image_id: str) -> list[dict]:
    response = client.get(f"/api/datasets/{dataset_id}/images/{image_id}/annotations")
    assert response.status_code == 200, response.text
    return response.json()


def test_versions_snapshot_activate_and_delete(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = upload_image(client, dataset_id)
    save_bbox(client, dataset_id, image["id"], class_id)

    empty = client.get(f"/api/datasets/{dataset_id}/versions")
    assert empty.status_code == 200 and empty.json() == []

    first = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "初版"})
    assert first.status_code == 201, first.text
    version_one = first.json()
    assert version_one["version_number"] == 1
    assert version_one["is_active"] is True
    assert version_one["note"] == "初版"
    assert version_one["image_count"] == 1
    assert version_one["annotation_count"] == 1
    assert version_one["class_count"] == 1

    # 继续修改工作区：改标注 + 再建版本
    save_bbox(client, dataset_id, image["id"], class_id, x=55)
    upload_image(client, dataset_id, "second.png")
    second = client.post(f"/api/datasets/{dataset_id}/versions", json={})
    assert second.status_code == 201, second.text
    version_two = second.json()
    assert version_two["version_number"] == 2
    assert version_two["is_active"] is True

    listed = client.get(f"/api/datasets/{dataset_id}/versions").json()
    assert [item["version_number"] for item in listed] == [2, 1]
    assert [item["is_active"] for item in listed] == [True, False]

    summary = client.get("/api/datasets").json()[0]
    assert summary["latest_version_number"] == 2
    assert summary["active_version_number"] == 2

    # 激活 v1：工作区回到 v1 状态（1 张图、原标注）
    activated = client.post(f"/api/datasets/{dataset_id}/versions/{version_one['id']}/activate")
    assert activated.status_code == 200, activated.text
    payload = activated.json()
    assert payload["restored_images"] == 1
    assert payload["skipped_images"] == 0
    assert payload["version"]["is_active"] is True

    summary = client.get("/api/datasets").json()[0]
    assert summary["image_count"] == 1
    assert summary["latest_version_number"] == 2
    assert summary["active_version_number"] == 1
    annotations = annotations_of(client, dataset_id, image["id"])
    assert len(annotations) == 1
    assert annotations[0]["bbox"]["x"] == 10

    # 激活版本不能删除；未激活版本可以
    blocked = client.delete(f"/api/datasets/{dataset_id}/versions/{version_one['id']}")
    assert blocked.status_code == 409, blocked.text
    removed = client.delete(f"/api/datasets/{dataset_id}/versions/{version_two['id']}")
    assert removed.status_code == 204, removed.text
    assert [item["version_number"] for item in client.get(f"/api/datasets/{dataset_id}/versions").json()] == [1]

    # 删除数据集时版本一并消失
    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 204
    assert client.get(f"/api/datasets/{dataset_id}/versions").status_code == 404


def test_activate_skips_images_whose_files_are_gone(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    keep = upload_image(client, dataset_id, "keep.png")
    gone = upload_image(client, dataset_id, "gone.png")
    save_bbox(client, dataset_id, keep["id"], class_id)
    save_bbox(client, dataset_id, gone["id"], class_id)

    created = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": None}).json()
    assert created["version_number"] == 1

    # 版本化之后从磁盘直接删除一张图片文件，再激活应跳过它
    from sqlalchemy import select as sa_select

    from app.core.models import ImageItem

    sessions = client.app.state.database.sessions()
    session = next(sessions)
    try:
        storage_name = session.scalar(sa_select(ImageItem.storage_name).where(ImageItem.id == gone["id"]))
    finally:
        session.close()
    client.app.state.storage.image_path(dataset_id, storage_name).unlink()

    # 工作区再改一刀，确保激活确实发生重写
    save_bbox(client, dataset_id, keep["id"], class_id, x=42)

    activated = client.post(f"/api/datasets/{dataset_id}/versions/{created['id']}/activate")
    assert activated.status_code == 200, activated.text
    assert activated.json()["restored_images"] == 1
    assert activated.json()["skipped_images"] == 1

    summary = client.get("/api/datasets").json()[0]
    assert summary["image_count"] == 1
    assert annotations_of(client, dataset_id, keep["id"])[0]["bbox"]["x"] == 10
    assert client.get(f"/api/datasets/{dataset_id}/images/{gone['id']}/annotations").status_code == 404


def test_active_version_list_reflects_workspace_changes(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = upload_image(client, dataset_id)
    save_bbox(client, dataset_id, image["id"], class_id)

    assert client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "初版"}).status_code == 201

    listed = client.get(f"/api/datasets/{dataset_id}/versions").json()
    assert listed[0]["image_count"] == 1
    assert listed[0]["annotation_count"] == 1
    assert listed[0]["has_pending_changes"] is False

    # 工作区新增图片后，激活中的版本实时展示最新统计
    added = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("second.png", png_bytes(color="#aa7744"), "image/png")},
    )
    assert added.status_code == 201, added.text
    listed = client.get(f"/api/datasets/{dataset_id}/versions").json()
    assert listed[0]["image_count"] == 2
    assert listed[0]["annotation_count"] == 1
    assert listed[0]["has_pending_changes"] is True

    # 新建版本归档后回到一致；旧版本保持创建时的快照统计
    assert client.post(f"/api/datasets/{dataset_id}/versions", json={}).status_code == 201
    listed = client.get(f"/api/datasets/{dataset_id}/versions").json()
    assert [(item["version_number"], item["image_count"]) for item in listed] == [(2, 2), (1, 1)]
    assert listed[0]["has_pending_changes"] is False
    assert listed[1]["has_pending_changes"] is None


def test_historical_active_version_makes_workspace_read_only(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = upload_image(client, dataset_id)
    save_bbox(client, dataset_id, image["id"], class_id)
    first = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "初版"}).json()

    upload_image(client, dataset_id, "second.png")
    assert client.post(f"/api/datasets/{dataset_id}/versions", json={}).status_code == 201

    # 激活历史版本后，改动工作区的端点一律 409；读取不受影响
    assert client.post(f"/api/datasets/{dataset_id}/versions/{first['id']}/activate").status_code == 200
    assert client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "dog"}).status_code == 409
    assert client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": []},
    ).status_code == 409
    blocked_upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("third.png", png_bytes(color="#8844aa"), "image/png")},
    )
    assert blocked_upload.status_code == 409, blocked_upload.text
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 200
    assert len(annotations_of(client, dataset_id, image["id"])) == 1

    # 新建版本是逃生通道：归档后工作区恢复可写
    assert client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "从 v1 继续"}).status_code == 201
    assert client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "dog"}).status_code == 201


def test_clone_version_creates_independent_dataset(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = upload_image(client, dataset_id)
    save_bbox(client, dataset_id, image["id"], class_id)
    first = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "初版"}).json()

    # 克隆后继续修改源工作区，不应影响副本
    save_bbox(client, dataset_id, image["id"], class_id, x=55)

    cloned = client.post(f"/api/datasets/{dataset_id}/versions/{first['id']}/clone", json={"name": "demo-副本"})
    assert cloned.status_code == 201, cloned.text
    body = cloned.json()
    new_id = body["dataset"]["id"]
    assert body["dataset"]["name"] == "demo-副本"
    assert body["dataset"]["task_type"] == "detect"
    assert body["imported_images"] == 1
    assert body["imported_annotations"] == 1
    assert body["skipped_images"] == 0

    # 克隆副本从零开始：无版本记录，标注停留在 v1 时刻
    assert client.get(f"/api/datasets/{new_id}/versions").json() == []
    cloned_image = client.get(f"/api/datasets/{new_id}/images").json()["items"][0]
    cloned_annotations = client.get(f"/api/datasets/{new_id}/images/{cloned_image['id']}/annotations").json()
    assert len(cloned_annotations) == 1
    assert cloned_annotations[0]["bbox"]["x"] == 10

    # 图片文件是复制而非引用：删除源数据集后副本仍完整可用
    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 204
    assert client.get(f"/api/datasets/{new_id}").json()["image_count"] == 1
    assert client.get(f"/api/images/{cloned_image['id']}/file").status_code == 200
    assert client.post(f"/api/datasets/{dataset_id}/versions/{first['id']}/clone", json={"name": "again"}).status_code == 404


def test_clone_version_skips_images_whose_files_are_gone(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    keep = upload_image(client, dataset_id, "keep.png")
    gone = upload_image(client, dataset_id, "gone.png")
    save_bbox(client, dataset_id, keep["id"], class_id)
    save_bbox(client, dataset_id, gone["id"], class_id)
    version = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": None}).json()

    from sqlalchemy import select as sa_select

    from app.core.models import ImageItem

    sessions = client.app.state.database.sessions()
    session = next(sessions)
    try:
        storage_name = session.scalar(sa_select(ImageItem.storage_name).where(ImageItem.id == gone["id"]))
    finally:
        session.close()
    client.app.state.storage.image_path(dataset_id, storage_name).unlink()

    cloned = client.post(f"/api/datasets/{dataset_id}/versions/{version['id']}/clone", json={"name": "partial"})
    assert cloned.status_code == 201, cloned.text
    body = cloned.json()
    assert body["imported_images"] == 1
    assert body["imported_annotations"] == 1
    assert body["skipped_images"] == 1
    assert client.get(f"/api/datasets/{body['dataset']['id']}").json()["image_count"] == 1


def test_clone_dataset_without_versions_clones_workspace(client):
    dataset_id = create_dataset(client, "detect")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = upload_image(client, dataset_id)
    save_bbox(client, dataset_id, image["id"], class_id)

    cloned = client.post(f"/api/datasets/{dataset_id}/clone", json={"name": "demo-工作区副本"})
    assert cloned.status_code == 201, cloned.text
    body = cloned.json()
    new_id = body["dataset"]["id"]
    assert body["dataset"]["task_type"] == "detect"
    assert body["imported_images"] == 1
    assert body["imported_annotations"] == 1
    assert body["skipped_images"] == 0

    cloned_image = client.get(f"/api/datasets/{new_id}/images").json()["items"][0]
    cloned_annotations = client.get(f"/api/datasets/{new_id}/images/{cloned_image['id']}/annotations").json()
    assert cloned_annotations[0]["bbox"]["x"] == 10
    assert client.get(f"/api/datasets/{new_id}/versions").json() == []

    # 源数据集不受影响，且仍然没有版本
    assert client.get(f"/api/datasets/{dataset_id}").json()["image_count"] == 1
    assert client.get(f"/api/datasets/{dataset_id}/versions").json() == []

    # 传不存在的 version_id 仍然 404
    missing = client.post(f"/api/datasets/{dataset_id}/clone", json={"name": "bad", "version_id": "dsv_missing"})
    assert missing.status_code == 404, missing.text
