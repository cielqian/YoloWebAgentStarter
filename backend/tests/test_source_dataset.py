from __future__ import annotations

import io
import json

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


def sse_events(response) -> list[dict]:
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events = [json.loads(line[len("data: "):]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert events, "SSE 流没有返回事件"
    return events


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
        f"/api/source-datasets/{dataset['id']}/images", params={"tag_ids": [tag_a["id"]]}
    ).json()
    assert filtered["total"] == 1

    upload_image(client, dataset["id"], "night.png")
    night_id = client.get(
        f"/api/source-datasets/{dataset['id']}/images", params={"query": "night"}
    ).json()["items"][0]["id"]
    client.patch(f"/api/source-datasets/{dataset['id']}/images/{night_id}", json={"tag_ids": [tag_a["id"]]})
    single = client.get(
        f"/api/source-datasets/{dataset['id']}/images", params={"tag_ids": [tag_a["id"]]}
    ).json()
    assert single["total"] == 2
    both = client.get(
        f"/api/source-datasets/{dataset['id']}/images", params={"tag_ids": [tag_a["id"], tag_b["id"]]}
    ).json()
    assert both["total"] == 1
    either = client.get(
        f"/api/source-datasets/{dataset['id']}/images",
        params={"tag_ids": [tag_a["id"], tag_b["id"]], "tag_match": "any"},
    ).json()
    assert either["total"] == 2

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

    def fake_fetch(self, path: str, *, recursive: bool, max_bytes: int, max_files=None, on_progress=None):
        captured["path"] = path
        captured["recursive"] = recursive
        return [("cam1/frame1.png", png_bytes()), ("cam1/notes.txt", b"skip me")], False

    monkeypatch.setattr(ftp_service.FtpService, "fetch_directory_images", fake_fetch)

    events = sse_events(client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote/cam1", "recursive": False},
    ))
    assert events[0] == {"type": "progress", "stage": "download", "synced": 0, "skipped": 0}
    assert events[-1] == {"type": "done", "synced": 1, "skipped": 1, "truncated": False}
    assert any(event["stage"] == "save" for event in events if event["type"] == "progress")
    assert captured == {"path": "/remote/cam1", "recursive": False}

    images = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"]
    assert images[0]["source_type"] == "ftp"
    assert images[0]["file_name"] == "frame1.png"


def test_upload_with_tags_applies_to_imported_images(client: TestClient) -> None:
    dataset = create_dataset(client)
    tag = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "白天"}).json()

    response = client.post(
        f"/api/source-datasets/{dataset['id']}/images/upload",
        files=[("files", ("one.png", png_bytes(), "image/png")), ("files", ("two.png", png_bytes(), "image/png"))],
        data={"tag_ids": [tag["id"]]},
    )
    assert response.status_code == 201
    page = client.get(f"/api/source-datasets/{dataset['id']}/images").json()
    assert page["total"] == 2
    assert [item["tags"][0]["name"] for item in page["items"]] == ["白天", "白天"]
    assert client.get(f"/api/source-datasets/{dataset['id']}/tags").json()[0]["image_count"] == 2

    other = create_dataset(client, "另一数据源")
    foreign_tag = client.post(f"/api/source-datasets/{other['id']}/tags", json={"name": "外来"}).json()
    rejected = client.post(
        f"/api/source-datasets/{dataset['id']}/images/upload",
        files=[("files", ("three.png", png_bytes(), "image/png"))],
        data={"tag_ids": [foreign_tag["id"]]},
    )
    assert rejected.status_code == 404
    assert rejected.json()["error"]["code"] == "source_tag_not_found"


def test_batch_add_tags(client: TestClient) -> None:
    dataset = create_dataset(client)
    ids = [upload_image(client, dataset["id"], f"img{i}.png") for i in range(3)]
    image_ids = [
        item["id"]
        for item in client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"]
    ]
    day = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "白天"}).json()
    night = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "夜间"}).json()

    response = client.post(
        f"/api/source-datasets/{dataset['id']}/images/batch-tags",
        json={"image_ids": image_ids, "tag_ids": [day["id"], night["id"]]},
    )
    assert response.status_code == 200
    assert response.json() == {"updated": 3}

    page = client.get(f"/api/source-datasets/{dataset['id']}/images").json()
    for item in page["items"]:
        assert [tag["name"] for tag in item["tags"]] == ["夜间", "白天"]

    # 重复应用同一标签不应产生重复关联。
    again = client.post(
        f"/api/source-datasets/{dataset['id']}/images/batch-tags",
        json={"image_ids": image_ids, "tag_ids": [day["id"]]},
    )
    assert again.status_code == 200
    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert {item["name"]: item["image_count"] for item in tags} == {"白天": 3, "夜间": 3}

    removed = client.post(
        f"/api/source-datasets/{dataset['id']}/images/batch-tags",
        json={"image_ids": image_ids[:2], "tag_ids": [day["id"]], "remove": True},
    )
    assert removed.status_code == 200
    assert removed.json() == {"updated": 2}
    counts = {item["name"]: item["image_count"] for item in client.get(f"/api/source-datasets/{dataset['id']}/tags").json()}
    assert counts == {"白天": 1, "夜间": 3}

    missing_image = client.post(
        f"/api/source-datasets/{dataset['id']}/images/batch-tags",
        json={"image_ids": ["simg_missing"], "tag_ids": [day["id"]]},
    )
    assert missing_image.status_code == 404
    assert missing_image.json()["error"]["code"] == "source_image_not_found"

    missing_tag = client.post(
        f"/api/source-datasets/{dataset['id']}/images/batch-tags",
        json={"image_ids": image_ids, "tag_ids": ["stag_missing"]},
    )
    assert missing_tag.status_code == 404
    assert missing_tag.json()["error"]["code"] == "source_tag_not_found"
    assert len(ids) == 3


def test_ftp_sync_with_selected_files(client: TestClient, monkeypatch) -> None:
    dataset = create_dataset(client)
    captured: dict = {}

    def fake_fetch_files(self, paths, *, max_bytes, on_progress=None):
        captured["paths"] = paths
        captured["max_bytes"] = max_bytes
        return [("one.png", png_bytes()), ("two.png", png_bytes())], 1

    monkeypatch.setattr(ftp_service.FtpService, "fetch_files", fake_fetch_files)

    events = sse_events(client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote", "recursive": False, "file_paths": ["/remote/one.png", "/remote/two.png", "/remote/skip.txt"]},
    ))
    assert events[-1] == {"type": "done", "synced": 2, "skipped": 1, "truncated": False}
    assert captured["paths"] == ["/remote/one.png", "/remote/two.png", "/remote/skip.txt"]

    images = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"]
    assert sorted(item["file_name"] for item in images) == ["one.png", "two.png"]
    assert all(item["source_type"] == "ftp" for item in images)


def test_image_thumbnail_generated_and_cached(client: TestClient) -> None:
    dataset = create_dataset(client)
    upload_image(client, dataset["id"], "shot.png")
    item = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"][0]
    assert item["thumbnail_url"].endswith("/thumbnail")

    first = client.get(item["thumbnail_url"])
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/jpeg"
    assert "max-age=31536000" in first.headers["cache-control"]
    assert len(first.content) > 0

    second = client.get(item["thumbnail_url"])
    assert second.status_code == 200
    assert second.content == first.content


def test_ftp_sync_with_tags(client: TestClient, monkeypatch) -> None:
    dataset = create_dataset(client, "FTP 带标签")
    tag = client.post(f"/api/source-datasets/{dataset['id']}/tags", json={"name": "夜间"}).json()

    monkeypatch.setattr(
        ftp_service.FtpService,
        "fetch_directory_images",
        lambda self, path, *, recursive, max_bytes, max_files=None, on_progress=None: ([("frame1.png", png_bytes())], False),
    )

    events = sse_events(client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote", "recursive": False, "tag_ids": [tag["id"]]},
    ))
    assert events[-1] == {"type": "done", "synced": 1, "skipped": 0, "truncated": False}
    item = client.get(f"/api/source-datasets/{dataset['id']}/images").json()["items"][0]
    assert [entry["name"] for entry in item["tags"]] == ["夜间"]


def test_ftp_sync_streams_download_and_save_progress(client: TestClient, monkeypatch) -> None:
    dataset = create_dataset(client, "FTP 进度")

    def fake_fetch(self, path, *, recursive, max_bytes, max_files=None, on_progress=None):
        files = [(f"img{index}.png", png_bytes()) for index in range(3)]
        for count in range(1, len(files) + 1):
            if on_progress is not None:
                on_progress(count)
        return files, False

    monkeypatch.setattr(ftp_service.FtpService, "fetch_directory_images", fake_fetch)

    events = sse_events(client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote"},
    ))
    downloads = [event["synced"] for event in events if event["type"] == "progress" and event["stage"] == "download"]
    assert downloads == [0, 1, 2, 3]
    saves = [event["synced"] for event in events if event["type"] == "progress" and event["stage"] == "save"]
    assert saves == [1, 2, 3]
    assert events[-1] == {"type": "done", "synced": 3, "skipped": 0, "truncated": False}


def test_ftp_sync_rejects_foreign_tag_before_download(client: TestClient, monkeypatch) -> None:
    dataset = create_dataset(client)
    other = create_dataset(client, "另一数据源")
    foreign = client.post(f"/api/source-datasets/{other['id']}/tags", json={"name": "外来"}).json()

    def fail_fetch(self, *args, **kwargs):
        raise AssertionError("标签校验失败时不应开始下载")

    monkeypatch.setattr(ftp_service.FtpService, "fetch_directory_images", fail_fetch)

    events = sse_events(client.post(
        f"/api/source-datasets/{dataset['id']}/images/ftp-sync",
        json={"path": "/remote", "tag_ids": [foreign["id"]]},
    ))
    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert events[0]["code"] == "source_tag_not_found"
