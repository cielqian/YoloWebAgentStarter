"""标注页服务端分页的接口契约：列表筛选/anchor 定位、单张图片、相邻图片。"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

BASE_TIME = datetime(2026, 1, 1, 12, 0, 0)


def upload_images(client: TestClient, dataset_id: str, count: int, split: str = "train") -> list[dict]:
    """上传 count 张内容各不相同的图片（内容相同会被 MD5 去重跳过）。"""
    files = [("files", (f"img-{index:03d}.png", png_bytes(color=f"#{(index + 1) * 0x010101:06x}"), "image/png")) for index in range(count)]
    response = client.post(f"/api/datasets/{dataset_id}/images/upload", files=files, data={"split": split})
    assert response.status_code == 201, response.text
    assert response.json()["imported"] == count
    return response.json()["items"]


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (20, 16)) -> bytes:
    import io

    from PIL import Image

    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def set_columns(client: TestClient, image_id: str, **values) -> None:
    from app.core.models import ImageItem

    with client.app.state.database.session_factory() as session:
        image = session.get(ImageItem, image_id)
        assert image is not None
        for key, value in values.items():
            setattr(image, key, value)
        session.commit()


def make_dataset(client: TestClient, count: int = 12) -> tuple[str, list[dict]]:
    """建数据集并上传 count 张图片，返回 (数据集 id, 按列表顺序排列的图片)。

    一次请求批量插入的行 created_at 相同，列表会退化为按随机 id 排序；
    这里按文件顺序写入递增的 created_at，让列表顺序确定、与返回值一致。
    """
    dataset_id = client.post("/api/datasets", json={"name": "paged", "task_type": "detect"}).json()["id"]
    items = upload_images(client, dataset_id, count)
    for index, item in enumerate(items):
        set_columns(client, item["id"], created_at=BASE_TIME + timedelta(seconds=index))
    return dataset_id, items


def list_images(client: TestClient, dataset_id: str, **params) -> dict:
    response = client.get(f"/api/datasets/{dataset_id}/images", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def ids(page: dict) -> list[str]:
    return [item["id"] for item in page["items"]]


def test_pages_are_sliced_in_the_database(client: TestClient):
    dataset_id, items = make_dataset(client, count=12)
    first = list_images(client, dataset_id, offset=0, limit=5)
    second = list_images(client, dataset_id, offset=5, limit=5)
    tail = list_images(client, dataset_id, offset=10, limit=5)

    assert first["total"] == 12 and first["offset"] == 0
    assert ids(first) == [item["id"] for item in items[:5]]
    assert second["offset"] == 5 and ids(second) == [item["id"] for item in items[5:10]]
    assert tail["offset"] == 10 and ids(tail) == [item["id"] for item in items[10:]]


def test_offset_defaults_to_zero_and_limit_is_capped(client: TestClient):
    dataset_id, _ = make_dataset(client, count=3)
    assert list_images(client, dataset_id)["offset"] == 0
    assert client.get(f"/api/datasets/{dataset_id}/images", params={"limit": 501}).status_code == 422
    assert client.get(f"/api/datasets/{dataset_id}/images", params={"offset": -1}).status_code == 422


def test_filters_by_split_and_status(client: TestClient):
    dataset_id, items = make_dataset(client, count=6)
    set_columns(client, items[0]["id"], split="val")
    set_columns(client, items[1]["id"], split="test")
    set_columns(client, items[2]["id"], status="annotated")

    assert ids(list_images(client, dataset_id, split="train")) == [items[2]["id"], items[3]["id"], items[4]["id"], items[5]["id"]]
    assert ids(list_images(client, dataset_id, split="val")) == [items[0]["id"]]
    assert ids(list_images(client, dataset_id, status="annotated")) == [items[2]["id"]]
    assert list_images(client, dataset_id, status="unannotated")["total"] == 5

    # 筛选组合，并且分页是相对于筛选后的结果
    combined = list_images(client, dataset_id, split="train", status="unannotated", offset=1, limit=1)
    assert combined["total"] == 3 and ids(combined) == [items[4]["id"]]


def test_rejects_unknown_split_and_status(client: TestClient):
    dataset_id, _ = make_dataset(client, count=1)
    assert client.get(f"/api/datasets/{dataset_id}/images", params={"split": "other"}).status_code == 422
    assert client.get(f"/api/datasets/{dataset_id}/images", params={"status": "deleted"}).status_code == 422


def test_anchor_returns_the_page_containing_the_image(client: TestClient):
    dataset_id, items = make_dataset(client, count=25)

    # 第 14 张（下标 13）在每页 5 张的第 3 页
    page = list_images(client, dataset_id, anchor=items[13]["id"], limit=5)
    assert page["offset"] == 10
    assert ids(page) == [item["id"] for item in items[10:15]]
    assert page["total"] == 25

    # 页首、页尾、最后一张都落在各自的页
    assert list_images(client, dataset_id, anchor=items[10]["id"], limit=5)["offset"] == 10
    assert list_images(client, dataset_id, anchor=items[14]["id"], limit=5)["offset"] == 10
    assert list_images(client, dataset_id, anchor=items[24]["id"], limit=5)["offset"] == 20
    assert list_images(client, dataset_id, anchor=items[0]["id"], limit=5)["offset"] == 0


def test_anchor_overrides_the_requested_offset(client: TestClient):
    dataset_id, items = make_dataset(client, count=12)
    page = list_images(client, dataset_id, offset=8, limit=4, anchor=items[1]["id"])
    assert page["offset"] == 0 and ids(page) == [item["id"] for item in items[:4]]


def test_anchor_is_positioned_within_the_filtered_result(client: TestClient):
    dataset_id, items = make_dataset(client, count=12)
    # train: 0,1,2,3,4,5,6,7,8,9   val: 10,11
    set_columns(client, items[10]["id"], split="val")
    set_columns(client, items[11]["id"], split="val")

    page = list_images(client, dataset_id, split="val", anchor=items[11]["id"], limit=1)
    assert page["offset"] == 1 and ids(page) == [items[11]["id"]]


def test_anchor_that_is_not_in_the_filtered_result_keeps_the_offset(client: TestClient):
    dataset_id, items = make_dataset(client, count=6)
    set_columns(client, items[0]["id"], split="val")

    page = list_images(client, dataset_id, split="val", offset=0, limit=4, anchor=items[1]["id"])
    assert page["offset"] == 0 and ids(page) == [items[0]["id"]]


@pytest.mark.parametrize("anchor_case", ["unknown", "other_dataset"])
def test_unknown_or_foreign_anchor_keeps_the_offset(client: TestClient, anchor_case: str):
    dataset_id, items = make_dataset(client, count=6)
    other_dataset, other_items = make_dataset(client, count=1)
    anchor = "img_missing" if anchor_case == "unknown" else other_items[0]["id"]
    page = list_images(client, dataset_id, offset=2, limit=2, anchor=anchor)
    assert page["offset"] == 2 and ids(page) == [items[2]["id"], items[3]["id"]]


def test_single_image_endpoint(client: TestClient):
    dataset_id, items = make_dataset(client, count=2)
    other_dataset, _ = make_dataset(client, count=1)

    response = client.get(f"/api/datasets/{dataset_id}/images/{items[1]['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == items[1]["id"]
    assert client.get(f"/api/datasets/{other_dataset}/images/{items[1]['id']}").status_code == 404
    assert client.get(f"/api/datasets/{dataset_id}/images/img_missing").status_code == 404


def neighbors(client: TestClient, dataset_id: str, image_id: str) -> dict:
    response = client.get(f"/api/datasets/{dataset_id}/images/{image_id}/neighbors")
    assert response.status_code == 200, response.text
    return response.json()


def test_neighbors_at_first_middle_and_last(client: TestClient):
    dataset_id, items = make_dataset(client, count=5)

    first = neighbors(client, dataset_id, items[0]["id"])
    assert (first["previous"], first["next"]["id"], first["index"], first["total"]) == (None, items[1]["id"], 0, 5)

    middle = neighbors(client, dataset_id, items[2]["id"])
    assert (middle["previous"]["id"], middle["next"]["id"], middle["index"]) == (items[1]["id"], items[3]["id"], 2)

    last = neighbors(client, dataset_id, items[4]["id"])
    assert (last["previous"]["id"], last["next"], last["index"]) == (items[3]["id"], None, 4)


def test_single_image_has_no_neighbors(client: TestClient):
    dataset_id, items = make_dataset(client, count=1)
    result = neighbors(client, dataset_id, items[0]["id"])
    assert (result["previous"], result["next"], result["index"], result["total"]) == (None, None, 0, 1)


def test_neighbors_ignore_sidebar_filters_and_follow_the_whole_dataset(client: TestClient):
    dataset_id, items = make_dataset(client, count=6)
    set_columns(client, items[1]["id"], split="val")
    set_columns(client, items[2]["id"], status="annotated")

    result = neighbors(client, dataset_id, items[1]["id"])
    assert (result["previous"]["id"], result["next"]["id"], result["index"], result["total"]) == (
        items[0]["id"], items[2]["id"], 1, 6,
    )


def test_order_breaks_ties_on_id_when_timestamps_are_identical(client: TestClient):
    dataset_id, items = make_dataset(client, count=4)
    for item in items:
        set_columns(client, item["id"], created_at=BASE_TIME)

    expected = sorted(item["id"] for item in items)
    page = list_images(client, dataset_id)
    assert ids(page) == expected

    second_id = expected[1]
    result = neighbors(client, dataset_id, second_id)
    assert result["index"] == 1
    assert result["previous"]["id"] == expected[0] and result["next"]["id"] == expected[2]

    anchored = list_images(client, dataset_id, anchor=expected[-1], limit=3)
    assert anchored["offset"] == 3 and ids(anchored) == [expected[3]]


def test_neighbors_follow_list_order_not_upload_order(client: TestClient):
    dataset_id, items = make_dataset(client, count=3)
    # 把最后上传的一张改成最早创建，它应排到最前
    set_columns(client, items[2]["id"], created_at=BASE_TIME - timedelta(days=1))
    set_columns(client, items[0]["id"], created_at=BASE_TIME)
    set_columns(client, items[1]["id"], created_at=BASE_TIME + timedelta(days=1))

    assert ids(list_images(client, dataset_id)) == [items[2]["id"], items[0]["id"], items[1]["id"]]
    result = neighbors(client, dataset_id, items[0]["id"])
    assert result["previous"]["id"] == items[2]["id"] and result["next"]["id"] == items[1]["id"]


def test_neighbors_reject_unknown_or_foreign_image(client: TestClient):
    dataset_id, items = make_dataset(client, count=2)
    other_dataset, _ = make_dataset(client, count=1)
    assert client.get(f"/api/datasets/{dataset_id}/images/img_missing/neighbors").status_code == 404
    assert client.get(f"/api/datasets/{other_dataset}/images/{items[0]['id']}/neighbors").status_code == 404


def test_neighbors_reflect_deletions(client: TestClient):
    dataset_id, items = make_dataset(client, count=4)
    assert client.delete(f"/api/datasets/{dataset_id}/images/{items[1]['id']}").status_code == 204

    result = neighbors(client, dataset_id, items[0]["id"])
    assert (result["next"]["id"], result["total"]) == (items[2]["id"], 3)
    assert client.get(f"/api/datasets/{dataset_id}/images/{items[1]['id']}").status_code == 404
