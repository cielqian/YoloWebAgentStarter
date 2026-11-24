from __future__ import annotations

import io
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.algorithm_test.ftp_import import import_yolo_into_test_dataset
from app.core.models import TestAnnotation, TestClassLabel, TestDataset, TestImage
from app.dataset.exchange.yolo import YoloArchiveLimits


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (60, 40)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def yolo_zip(images: dict[str, bytes], labels: dict[str, str], data_yaml: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in images.items():
            archive.writestr(f"images/{name}", content)
        for name, text in labels.items():
            archive.writestr(f"labels/{name}", text)
        if data_yaml is not None:
            archive.writestr("data.yaml", data_yaml)
    return buffer.getvalue()


def make_dataset(session, name: str = "塔筒裂缝-FTP集", task_type: str = "detect") -> TestDataset:
    dataset = TestDataset(id="tds_ftp1", name=name, task_type=task_type, source="ftp")
    session.add(dataset)
    session.commit()
    session.refresh(dataset)
    return dataset


def test_import_yolo_marks_expected_annotations(client: TestClient, tmp_path: Path) -> None:
    from app.core.storage import Storage

    storage = Storage(tmp_path / "data", tmp_path / "imports")
    payload = yolo_zip(
        images={"a.png": png_bytes(size=(100, 80)), "b.png": png_bytes("#aa4444", size=(100, 80))},
        labels={"a.txt": "0 0.5 0.5 0.4 0.5\n1 0.2 0.2 0.1 0.1", "b.txt": ""},
        data_yaml="names:\n  0: 裂缝\n  1: 锈蚀\n",
    )
    with client.app.state.database.session_factory() as session:
        dataset = make_dataset(session)
        images, annotations = import_yolo_into_test_dataset(session, storage, dataset, payload, YoloArchiveLimits())
        assert images == 2
        assert annotations == 2
        assert dataset.import_state == "completed"
        assert dataset.import_progress == 100.0

        stored_images = list(session.scalars(select(TestImage).order_by(TestImage.file_name)))
        assert [item.file_name for item in stored_images] == ["a.png", "b.png"]
        # a.png 有 2 条预期标注(标记完成),b.png 空 label(未标记)
        statuses = {item.file_name: item.status for item in stored_images}
        assert statuses["a.png"] == "marked"
        assert statuses["b.png"] == "unmarked"

        anns = list(session.scalars(select(TestAnnotation).order_by(TestAnnotation.sort_order)))
        assert len(anns) == 2
        assert anns[0].type == "bbox"
        assert anns[0].x is not None and 0 <= anns[0].x <= 100
        # 归一化 0.5,0.5,0.4,0.5 → x=30,y=20,w=40,h=40
        assert abs(anns[0].x - 30.0) < 1e-6 and abs(anns[0].width - 40.0) < 1e-6
        assert anns[0].source == "imported"

        classes = list(session.scalars(select(TestAnnotation.test_class_id)))
        assert len(set(classes)) == 2


def test_from_ftp_endpoint_creates_placeholder_and_runs(client: TestClient) -> None:
    """端点层面:占位数据集立即返回,后台线程把 zip 写入并落终态。"""

    payload = yolo_zip(
        images={"only.png": png_bytes(size=(80, 60))},
        labels={},
    )
    # 替换 FTP 取数:直接返回内存 zip
    import app.api.routers.datasets as datasets_router

    original = datasets_router._ftp_yolo_payload
    datasets_router._ftp_yolo_payload = lambda settings, p: payload
    try:
        response = client.post(
            "/api/algorithm-test/datasets/from-ftp",
            json={"name": "FTP 集", "task_type": "detect", "path": "/data/turbine.zip", "source": "zip"},
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["source"] == "ftp"
        assert body["import_state"] == "importing"

        # 后台线程很快完成;轮询等终态
        import time

        for _ in range(50):
            detail = client.get(f"/api/algorithm-test/datasets/{body['id']}").json()
            if detail["import_state"] != "importing":
                break
            time.sleep(0.1)
        assert detail["import_state"] == "completed", detail.get("import_message")
        assert detail["image_count"] == 1
    finally:
        datasets_router._ftp_yolo_payload = original


def test_from_ftp_rejects_non_zip(client: TestClient) -> None:
    response = client.post(
        "/api/algorithm-test/datasets/from-ftp",
        json={"name": "坏路径", "task_type": "detect", "path": "/data/turbine.rar", "source": "zip"},
    )
    assert response.status_code == 422


def test_import_yolo_classify_layout(client: TestClient, tmp_path: Path) -> None:
    from app.core.storage import Storage
    from sqlalchemy import select

    storage = Storage(tmp_path / "data", tmp_path / "imports")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("train/正常/a.png", png_bytes())
        archive.writestr("train/锈蚀/b.png", png_bytes("#aa4444"))
    with client.app.state.database.session_factory() as session:
        dataset = make_dataset(session, name="分类FTP集", task_type="classify")
        images, annotations = import_yolo_into_test_dataset(session, storage, dataset, buffer.getvalue(), YoloArchiveLimits())
        assert images == 2
        assert annotations == 2

        from app.core.models import TestAnnotation, TestClassLabel, TestImage

        classes = list(session.scalars(select(TestClassLabel).order_by(TestClassLabel.name)))
        assert [item.name for item in classes] == ["正常", "锈蚀"]
        stored = list(session.scalars(select(TestImage)))
        assert all(item.status == "marked" for item in stored)
        anns = list(session.scalars(select(TestAnnotation)))
        assert all(item.type == "classify" for item in anns)


def test_import_yolo_dedup_by_md5(client: TestClient, tmp_path: Path) -> None:
    from app.core.storage import Storage
    from sqlalchemy import select

    storage = Storage(tmp_path / "data", tmp_path / "imports")
    same = png_bytes()
    payload = yolo_zip(images={"a.png": same, "b.png": same}, labels={})
    with client.app.state.database.session_factory() as session:
        dataset = make_dataset(session)
        images, _ = import_yolo_into_test_dataset(session, storage, dataset, payload, YoloArchiveLimits())
        assert images == 1

        from app.core.models import TestImage

        assert len(list(session.scalars(select(TestImage)))) == 1
