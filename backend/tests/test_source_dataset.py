from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image

from app.ftp import service as ftp_service


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (60, 40)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def create_dataset(client: TestClient, name: str = "路面抓拍") -> dict:
    response = client.post("/api/source-datasets", json={"name": name, "description": "测试数据源"})
    assert response.status_code == 201
    return response.json()


def upload_image(client: TestClient, dataset_id: str, file_name: str = "a.png") -> dict:
    response = client.post(
        f"/api/source-datasets/{dataset_id}/images/upload",
        files=[("files", (file_name, png_bytes(), "image/png"))],
    )
    assert response.status_code == 201
    return response.json()


def test_source_dataset_crud(client: TestClient) -> None:
    created = create_dataset(client)
    assert created["name"] == "路面抓拍"
    assert created["image_count"] == 0

    listed = client.get("/api/source-datasets").json()
    assert [item["id"] for item in listed] == [created["id"]]

    renamed = client.patch(f"/api/source-datasets/{created['id']}", json={"name": "夜间抓拍", "description": None})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "夜间抓拍"

    assert client.delete(f"/api/source-datasets/{created['id']}").status_code == 204
    assert client.get("/api/source-datasets").json() == []
    assert client.get(f"/api/source-datasets/{created['id']}/images").status_code == 404


def test_upload_list_preview_and_delete_images(client: TestClient) -> None:
    dataset = create_dataset(client)
    result = upload_image(client, dataset["id"], "first.png")
    upload_image(client, dataset["id"], "first.png")
    assert result["imported"] == 1 and result["invalid"] == 0

    page = client.get(f"/api/source-datasets/{dataset['id']}/images").json()
    assert page["total"] == 2
    first = page["items"][0]
    assert first["width"] == 60 and first["height"] == 40
    assert first["source_type"] == "upload"
    assert first["tags"] == []

    file_response = client.get(first["file_url"])
    assert file_response.status_code == 200
    assert file_response.headers["content-type"].startswith("image/png")

    query = client.get(f"/api/source-datasets/{dataset['id']}/images", params={"query": "first"}).json()
    assert query["total"] == 2
    missing = client.get(f"/api/source-datasets/{dataset['id']}/images", params={"query": "nope"}).json()
    assert missing["total"] == 0

    dataset_after = client.get("/api/source-datasets").json()[0]
    assert dataset_after["image_count"] == 2

    assert client.delete(f"/api/source-datasets/{dataset['id']}/images/{page['items'][-1]['id']}").status_code == 204
    assert client.get(f"/api/source-datasets/{dataset['id']}/images").json()["total"] == 1


def test_upload_invalid_files_are_counted(client: TestClient) -> None:
    dataset = create_dataset(client)
    response = client.post(
        f"/api/source-datasets/{dataset['id']}/images/upload",
        files=[
            ("files", ("broken.png", b"not an image", "image/png")),
            ("files", ("readme.txt", b"hello", "text/plain")),
        ],
    )
    assert response.status_code == 201
    assert response.json() == {"imported": 0, "invalid": 2}
    assert client.get(f"/api/source-datasets/{dataset['id']}/images").json()["total"] == 0


def test_tags_support_multiple_per_image(client: TestClient) -> None:
    dataset = create_dataset(client)
    upload_image(client, dataset["id"], "street.png")
    image_id = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"][0]["id"]

    tag_a = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "白天"}).json()
    tag_b = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "雨天", "color": "#22c55e"}).json()
    assert client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "白天"}).status_code == 409

    patched = client.patch(
        f"/api/source-datasets/{dataset['id']}/images/{image_id}",
        json={"tag_ids": [tag_a["id"], tag_b["id"]], "file_name": "street-day.png"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["file_name"] == "street-day.png"
    assert {tag["name"] for tag in body["tags"]} == {"白天", "雨天"}

    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert all(tag["image_count"] == 1 for tag in tags)

    filtered = client.get(
        f"/api/source-datasets/{dataset['id']}/images", params={"tag_id": tag_a["id"]}
    ).json()
    assert filtered["total"] == 1
    untagged = client.patch(
        f"/api/source-datasets/{dataset['id']}/images/{image_id}", json={"tag_ids": []}
    ).json()
    assert untagged["tags"] == []

    renamed = client.patch(f"/api/source-datasets/{dataset['id']}/tags/{tag_b['id']}", json={"name": "雪天"})
    assert renamed.json()["name"] == "雪天"
    foreign = client.patch(
        f"/api/source-datasets/{dataset['id']}/images/{image_id}", json={"tag_ids": ["stag_missing"]}
    )
    assert foreign.status_code == 404

    assert client.delete(f"/api/source-datasets/{dataset['id']}/tags/{tag_a['id']}").status_code == 204
    assert len(client.get(f"/api/source-datasets/{dataset['id']}/tags").json()) == 1
    assert client.get("/api/source-datasets").json()[0]["tag_count"] == 1


def test_ftp_sync_imports_images(client: TestClient, monkeypatch) -> None:
    dataset = create_dataset(client, "FTP 同步")
    captured: dict = {}

    def fake_fetch(self, path: str, *, recursive: bool, max_bytes: int):
        captured["path"] = path
        captured["recursive"] = recursive
        return [("cam1/frame1.png", png_bytes()), ("cam1/notes.txt", b"skip me")]

    monkeypatch.setattr(ftp_service.FtpService, "fetch_directory_images", fake_fetch)

    response = client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote/cam1", "recursive": False},
    )
    assert response.status_code == 200
    assert response.json() == {"synced": 1, "skipped": 1}
    assert captured == {"path": "/remote/cam1", "recursive": False}

    images = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"]
    assert images[0]["source_type"] == "ftp"
    assert images[0]["file_name"] == "frame1.png"
