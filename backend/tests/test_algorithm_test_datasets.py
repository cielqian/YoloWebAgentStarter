from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (60, 40)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def create_test_dataset(client: TestClient, name: str = "塔筒裂缝-测试集", task_type: str = "detect", **extra) -> dict:
    payload = {"name": name, "task_type": task_type, **extra}
    response = client.post("/api/algorithm-test/datasets", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def upload_images(client: TestClient, dataset_id: str, files: list[tuple[str, bytes]]) -> dict:
    response = client.post(
        f"/api/algorithm-test/datasets/{dataset_id}/images/upload",
        files=[("files", (name, content, "image/png")) for name, content in files],
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_class(client: TestClient, dataset_id: str, name: str = "裂缝") -> dict:
    response = client.post(f"/api/algorithm-test/datasets/{dataset_id}/classes", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


def test_test_dataset_crud_and_progress(client: TestClient) -> None:
    created = create_test_dataset(client, purpose_tag="regression", ftp_dir="/ywa-test/ds1")
    assert created["purpose_tag"] == "regression"
    assert created["ftp_dir"] == "/ywa-test/ds1"
    assert created["image_count"] == 0
    assert created["marked_percent"] == 0.0

    create_class(client, created["id"], name="裂缝")
    create_class(client, created["id"], name="锈蚀")
    upload_images(client, created["id"], [("a.png", png_bytes()), ("b.png", png_bytes("#aa4444"))])

    listed = client.get("/api/algorithm-test/datasets").json()
    target = next(item for item in listed if item["id"] == created["id"])
    assert target["image_count"] == 2
    assert target["class_count"] == 2
    assert target["marked_count"] == 0

    renamed = client.patch(f"/api/algorithm-test/datasets/{created['id']}", json={"version": "v1.2", "purpose_tag": "hard"})
    assert renamed.status_code == 200
    assert renamed.json()["version"] == "v1.2"
    assert renamed.json()["purpose_tag"] == "hard"

    assert client.delete(f"/api/algorithm-test/datasets/{created['id']}").status_code == 204
    assert client.get(f"/api/algorithm-test/datasets/{created['id']}").status_code == 404


def test_rejects_unsupported_task_types(client: TestClient) -> None:
    response = client.post("/api/algorithm-test/datasets", json={"name": "OCR 集", "task_type": "ocr"})
    assert response.status_code == 422
    response = client.post("/api/algorithm-test/datasets", json={"name": "POSE 集", "task_type": "pose"})
    assert response.status_code == 422


def test_upload_md5_dedup(client: TestClient) -> None:
    dataset = create_test_dataset(client)
    same = png_bytes()
    result = upload_images(client, dataset["id"], [("a.png", same), ("b.png", same), ("c.png", png_bytes("#00ff00"))])
    assert result["imported"] == 2
    assert result["duplicates"] == ["b.png"]
    # 再传相同内容仍去重
    again = upload_images(client, dataset["id"], [("a2.png", same)])
    assert again["imported"] == 0


def test_image_pagination_and_filters(client: TestClient) -> None:
    dataset = create_test_dataset(client)
    colors = ["#111111", "#222222", "#333333", "#444444", "#555555"]
    upload_images(client, dataset["id"], [(f"{index}.png", png_bytes(color)) for index, color in enumerate(colors)])
    page = client.get(f"/api/algorithm-test/datasets/{dataset['id']}/images", params={"offset": 0, "limit": 2}).json()
    assert page["total"] == 5
    assert len(page["items"]) == 2
    unmarked = client.get(f"/api/algorithm-test/datasets/{dataset['id']}/images", params={"status": "marked"}).json()
    assert unmarked["total"] == 0
    neighbors = client.get(f"/api/algorithm-test/datasets/{dataset['id']}/images/{page['items'][1]['id']}/neighbors").json()
    assert neighbors["index"] == 1
    assert neighbors["previous"]["id"] == page["items"][0]["id"]
    assert neighbors["next"] is not None


def test_expected_annotations_bbox(client: TestClient) -> None:
    dataset = create_test_dataset(client, task_type="detect")
    classes = [create_class(client, dataset["id"], name="裂缝"), create_class(client, dataset["id"], name="锈蚀")]
    uploaded = upload_images(client, dataset["id"], [("a.png", png_bytes(size=(200, 120)))])
    image_id = uploaded["items"][0]["id"]

    empty = client.get(f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations")
    assert empty.status_code == 200
    assert empty.json() == []

    annotations = [
        {"type": "bbox", "class_id": classes[0]["id"], "bbox": {"x": 10, "y": 10, "width": 50, "height": 40}, "difficult": False},
        {"type": "bbox", "class_id": classes[1]["id"], "bbox": {"x": 100, "y": 30, "width": 60, "height": 50}, "difficult": True},
    ]
    saved = client.put(f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations", json={"annotations": annotations})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert len(body) == 2
    assert body[0]["label"] == "裂缝"
    assert body[1]["difficult"] is True

    detail = client.get(f"/api/algorithm-test/datasets/{dataset['id']}").json()
    assert detail["marked_count"] == 1

    # 越界框被拒绝
    bad = client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": classes[0]["id"], "bbox": {"x": 150, "y": 80, "width": 100, "height": 100}}]},
    )
    assert bad.status_code == 422

    # 清空标注回到 unmarked
    cleared = client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations", json={"annotations": []}
    )
    assert cleared.status_code == 200
    assert cleared.json() == []
    detail = client.get(f"/api/algorithm-test/datasets/{dataset['id']}").json()
    assert detail["marked_count"] == 0


def test_expected_annotations_classify_single(client: TestClient) -> None:
    dataset = create_test_dataset(client, task_type="classify")
    classes = [create_class(client, dataset["id"], name="正常"), create_class(client, dataset["id"], name="锈蚀")]
    uploaded = upload_images(client, dataset["id"], [("a.png", png_bytes())])
    image_id = uploaded["items"][0]["id"]

    # classify 只允许一个预期类别
    two = client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations",
        json={"annotations": [{"type": "classify", "class_id": classes[0]["id"]}, {"type": "classify", "class_id": classes[1]["id"]}]},
    )
    assert two.status_code == 422

    one = client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations",
        json={"annotations": [{"type": "classify", "class_id": classes[1]["id"]}]},
    )
    assert one.status_code == 200
    assert one.json()[0]["label"] == "锈蚀"

    # 检测框类型与分类数据集不符
    mismatch = client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": classes[0]["id"], "bbox": {"x": 1, "y": 1, "width": 5, "height": 5}}]},
    )
    assert mismatch.status_code == 422


def test_image_point_id_and_delete(client: TestClient) -> None:
    dataset = create_test_dataset(client)
    uploaded = upload_images(client, dataset["id"], [("a.png", png_bytes())])
    image_id = uploaded["items"][0]["id"]

    patched = client.patch(f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}", json={"point_id": "point-42"})
    assert patched.status_code == 200
    assert patched.json()["point_id"] == "point-42"

    assert client.delete(f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}").status_code == 204
    page = client.get(f"/api/algorithm-test/datasets/{dataset['id']}/images").json()
    assert page["total"] == 0


def test_class_in_use_cannot_delete(client: TestClient) -> None:
    dataset = create_test_dataset(client)
    class_item = create_class(client, dataset["id"], name="裂缝")
    uploaded = upload_images(client, dataset["id"], [("a.png", png_bytes(size=(100, 100)))])
    image_id = uploaded["items"][0]["id"]
    client.put(
        f"/api/algorithm-test/datasets/{dataset['id']}/images/{image_id}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_item["id"], "bbox": {"x": 5, "y": 5, "width": 20, "height": 20}}]},
    )
    conflict = client.delete(f"/api/algorithm-test/datasets/{dataset['id']}/classes/{class_item['id']}")
    assert conflict.status_code == 409


def test_class_template_import(client: TestClient) -> None:
    template = client.post("/api/class-templates", json={"name": "螺栓松动"}).json()
    dataset = create_test_dataset(client)
    imported = client.post(
        f"/api/algorithm-test/datasets/{dataset['id']}/classes/import", json={"template_ids": [template["id"]]}
    )
    assert imported.status_code == 200
    assert [item["name"] for item in imported.json()["imported"]] == ["螺栓松动"]
    again = client.post(
        f"/api/algorithm-test/datasets/{dataset['id']}/classes/import", json={"template_ids": [template["id"]]}
    )
    assert again.json()["skipped_names"] == ["螺栓松动"]


def test_image_file_and_thumbnail(client: TestClient) -> None:
    dataset = create_test_dataset(client)
    uploaded = upload_images(client, dataset["id"], [("a.png", png_bytes())])
    image_id = uploaded["items"][0]["id"]
    file_response = client.get(f"/api/algorithm-test/images/{image_id}/file")
    assert file_response.status_code == 200
    assert file_response.headers["content-type"] == "image/png"
    thumb = client.get(f"/api/algorithm-test/images/{image_id}/thumbnail")
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"
