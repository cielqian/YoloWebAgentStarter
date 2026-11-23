"""图片上传的 MD5 去重：重复文件不导入，并在响应里点名。"""

from __future__ import annotations

import io

from fastapi.testclient import TestClient
from PIL import Image


def png_bytes(color: str) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (20, 16), color).save(output, format="PNG")
    return output.getvalue()


def upload(client: TestClient, dataset_id: str, files: list[tuple[str, bytes]], split: str = "train") -> dict:
    response = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files=[("files", (name, content, "image/png")) for name, content in files],
        data={"split": split},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_duplicate_files_are_skipped_and_reported(client: TestClient):
    dataset_id = client.post("/api/datasets", json={"name": "dedup", "task_type": "detect"}).json()["id"]
    red, blue = png_bytes("#ff0000"), png_bytes("#0000ff")

    first = upload(client, dataset_id, [("a.png", red), ("b.png", blue)])
    assert (first["imported"], first["duplicates"]) == (2, [])

    # 跨请求:与已有图片内容相同
    second = upload(client, dataset_id, [("c.png", png_bytes("#00ff00")), ("a-copy.png", red)])
    assert (second["imported"], second["duplicates"]) == (1, ["a-copy.png"])
    assert [item["file_name"] for item in second["items"]] == ["c.png"]

    # 同一请求内:两个文件内容相同,只导入第一个
    third = upload(client, dataset_id, [("d.png", png_bytes("#ffff00")), ("d-again.png", png_bytes("#ffff00"))])
    assert (third["imported"], third["duplicates"]) == (1, ["d-again.png"])

    page = client.get(f"/api/datasets/{dataset_id}/images", params={"limit": 500}).json()
    assert page["total"] == 4
    # 不比较顺序:同一请求批量插入的行 created_at 相同,批内按随机 id 排序
    assert sorted(item["file_name"] for item in page["items"]) == ["a.png", "b.png", "c.png", "d.png"]


def test_same_content_in_another_dataset_is_not_a_duplicate(client: TestClient):
    def dataset(name: str) -> str:
        return client.post("/api/datasets", json={"name": name, "task_type": "detect"}).json()["id"]

    first, second = dataset("dedup-1"), dataset("dedup-2")
    content = png_bytes("#aa00aa")
    assert upload(client, first, [("x.png", content)])["imported"] == 1
    assert upload(client, second, [("x.png", content)])["imported"] == 1
