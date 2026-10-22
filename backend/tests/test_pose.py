"""End-to-end coverage for the pose task family: dataset config, annotation
validation, YOLO exchange, versions, training wiring, inference parsing, and
auto annotation."""

from __future__ import annotations

import io
import time
import zipfile

import pytest
import yaml
from PIL import Image

from app.dataset.annotation.geometry import validate_keypoints
from app.models.result_parser import Detection, YoloResultParser
from app.training.config import build_training_command, infer_model_family, validate_model_family
from app.training.observability.metrics import TrainingMetricsParser
from app.core.task_types import TaskType


def png_bytes(color: str = "#4477aa", size: tuple[int, int] = (100, 80)) -> bytes:
    image = Image.new("RGB", size, color)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def create_pose_dataset(client, kpt_count: int = 4, kpt_dim: int = 3) -> dict:
    response = client.post(
        "/api/datasets",
        json={"name": "pose-demo", "task_type": "pose", "pose_config": {"kpt_count": kpt_count, "kpt_dim": kpt_dim}},
    )
    assert response.status_code == 201, response.text
    return response.json()


def pose_archive(*, kpt_shape: tuple[int, int] | None = (4, 3), label_line: str | None = None) -> bytes:
    """Build a minimal YOLO pose ZIP: one image, one class, one label line."""

    label = label_line if label_line is not None else "0 0.5 0.5 0.4 0.5 0.4 0.5 2 0.6 0.4 2 0.6 0.6 1 0.4 0.6 0"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        document = {"names": ["person"], "path": ".", "train": "images/train", "val": "images/val"}
        if kpt_shape is not None:
            document["kpt_shape"] = list(kpt_shape)
        archive.writestr("data.yaml", yaml.safe_dump(document))
        archive.writestr("images/train/frame.png", png_bytes())
        archive.writestr("labels/train/frame.txt", label + "\n")
    return output.getvalue()


# ---------------------------------------------------------------------------
# dataset + annotation CRUD
# ---------------------------------------------------------------------------


def test_pose_dataset_requires_pose_config(client):
    rejected = client.post("/api/datasets", json={"name": "no-config", "task_type": "pose"})
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["error"]["code"] == "pose_config_required"

    created = client.post(
        "/api/datasets",
        json={"name": "with-config", "task_type": "pose", "pose_config": {"kpt_count": 5, "kpt_dim": 2}},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["task_type"] == "pose"
    assert body["pose_config"]["kpt_count"] == 5
    assert body["pose_config"]["kpt_dim"] == 2


def test_pose_dataset_rejects_mismatched_keypoint_names(client):
    rejected = client.post(
        "/api/datasets",
        json={"name": "bad-names", "task_type": "pose", "pose_config": {"kpt_count": 4, "kpt_dim": 3, "kpt_names": ["a", "b"]}},
    )
    assert rejected.status_code == 422, rejected.text


def _upload_pose_ready_image(client, dataset_id: str, split: str = "train") -> dict:
    upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        data={"split": split},
        files={"files": ("pose.png", png_bytes(), "image/png")},
    )
    assert upload.status_code == 201, upload.text
    return upload.json()["items"][0]


def test_pose_annotation_roundtrip_and_validation(client):
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    image = _upload_pose_ready_image(client, dataset_id)

    payload = {
        "annotations": [
            {
                "type": "pose",
                "class_id": class_id,
                "bbox": {"x": 10, "y": 12, "width": 40, "height": 50},
                "keypoints": [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]],
            }
        ]
    }
    saved = client.put(f"/api/datasets/{dataset_id}/images/{image['id']}/annotations", json=payload)
    assert saved.status_code == 200, saved.text
    annotation = saved.json()[0]
    assert annotation["type"] == "pose"
    assert annotation["bbox"] == {"x": 10.0, "y": 12.0, "width": 40.0, "height": 50.0}
    assert annotation["keypoints"] == [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]

    wrong_count = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 5, "y": 5, "width": 20, "height": 20}, "keypoints": [[1, 1, 2]]}]},
    )
    assert wrong_count.status_code == 422, wrong_count.text
    assert wrong_count.json()["error"]["code"] == "keypoint_count_mismatch"

    out_of_bounds = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 5, "y": 5, "width": 20, "height": 20}, "keypoints": [[500.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]}]},
    )
    assert out_of_bounds.status_code == 422, out_of_bounds.text
    assert out_of_bounds.json()["error"]["code"] == "keypoint_out_of_bounds"

    family_mismatch = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": 5, "y": 5, "width": 20, "height": 20}}]},
    )
    assert family_mismatch.status_code == 422, family_mismatch.text
    assert family_mismatch.json()["error"]["code"] == "annotation_family_mismatch"

    validation = client.post(f"/api/datasets/{dataset_id}/validate")
    assert validation.status_code == 200, validation.text
    assert validation.json()["valid"] is True


def test_geometry_validate_keypoints_contract():
    valid = [(10, 10, 2), (20, 10, 1), (0, 0, 0)]
    validate_keypoints(valid, 3, 100, 80)
    with pytest.raises(Exception):
        validate_keypoints(valid, 4, 100, 80)
    with pytest.raises(Exception):
        validate_keypoints([(101, 10, 2), (20, 10, 1), (0, 0, 0)], 3, 100, 80)
    # unlabeled keypoints may sit anywhere; their position is ignored
    validate_keypoints([(500, 500, 0), (20, 10, 1), (0, 0, 0)], 3, 100, 80)


# ---------------------------------------------------------------------------
# YOLO exchange
# ---------------------------------------------------------------------------


def test_pose_yolo_export_writes_kpt_shape_and_labels(client):
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    image = _upload_pose_ready_image(client, dataset_id, split="val")
    client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 40, "height": 50}, "keypoints": [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]}]},
    )

    exported = client.get(f"/api/datasets/{dataset_id}/export/yolo")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        document = yaml.safe_load(archive.read("data.yaml"))
        assert document["kpt_shape"] == [4, 3]
        label_name = next(name for name in archive.namelist() if name.startswith("labels/val/"))
        values = archive.read(label_name).decode().split()
    assert len(values) == 1 + 4 + 4 * 3
    assert values[0] == "0"
    assert values[1:5] == ["0.30000000", "0.46250000", "0.40000000", "0.62500000"]
    # unlabeled keypoint exports as zeros
    assert values[-3:] == ["0.00000000", "0.00000000", "0"]


def test_pose_yolo_import_round_trip(client):
    archive = pose_archive()
    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "pose-import", "task_type": "pose"},
        files={"file": ("pose.zip", archive, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    body = imported.json()
    assert body["imported_annotations"] == 1
    dataset = body["dataset"]
    assert dataset["pose_config"]["kpt_count"] == 4 and dataset["pose_config"]["kpt_dim"] == 3

    annotations = client.get(
        f"/api/datasets/{dataset['id']}/images/{_first_image_id(client, dataset['id'])}/annotations"
    ).json()
    assert annotations[0]["type"] == "pose"
    assert annotations[0]["keypoints"] == [[40.0, 40.0, 2], [60.0, 32.0, 2], [60.0, 48.0, 1], [0.0, 0.0, 0]]
    assert annotations[0]["bbox"] == {"x": 30.0, "y": 20.0, "width": 40.0, "height": 40.0}

    re_exported = client.get(f"/api/datasets/{dataset['id']}/export/yolo")
    assert re_exported.status_code == 200, re_exported.text
    round_tripped = client.post(
        "/api/datasets/import/yolo",
        data={"name": "pose-round-trip", "task_type": "pose"},
        files={"file": ("pose2.zip", re_exported.content, "application/zip")},
    )
    assert round_tripped.status_code == 201, round_tripped.text
    assert round_tripped.json()["imported_annotations"] == 1


def _first_image_id(client, dataset_id: str) -> str:
    return client.get(f"/api/datasets/{dataset_id}/images").json()["items"][0]["id"]


def test_pose_import_infers_shape_from_label_lines(client):
    archive = pose_archive(kpt_shape=None, label_line="0 0.5 0.5 0.4 0.5 0.4 0.5 2 0.6 0.4 2 0.6 0.6 2 0.4 0.6 2")
    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "pose-infer", "task_type": "pose"},
        files={"file": ("pose.zip", archive, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["dataset"]["pose_config"]["kpt_count"] == 4


def test_pose_import_rejects_config_and_archive_mismatch(client):
    from app.core.schemas import DatasetCreate
    from app.dataset.exchange.yolo import import_dataset

    archive = pose_archive()
    with client.app.state.database.session_factory() as session:
        with pytest.raises(Exception) as excinfo:
            import_dataset(
                session,
                client.app.state.storage,
                archive,
                DatasetCreate(name="pose-mismatch", task_type=TaskType.POSE, pose_config={"kpt_count": 6, "kpt_dim": 3}),
            )
        assert "pose_shape_mismatch" in str(excinfo.value.error_code)


def test_pose_import_rejects_malformed_label_lines(client):
    # 4×3 骨架需要 4+12 个数值；这一行只有 4+6 个。
    archive = pose_archive(label_line="0 0.5 0.5 0.4 0.5 0.4 0.5 2 0.6 0.4 2")
    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "pose-bad-label", "task_type": "pose"},
        files={"file": ("pose.zip", archive, "application/zip")},
    )
    assert imported.status_code == 422, imported.text
    assert imported.json()["error"]["code"] == "invalid_pose_label"


def test_pose_import_without_any_pose_signal_fails(client):
    archive = pose_archive(kpt_shape=None, label_line="0 0.5 0.5 0.4 0.5")
    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "pose-no-signal", "task_type": "pose"},
        files={"file": ("pose.zip", archive, "application/zip")},
    )
    assert imported.status_code == 422, imported.text
    assert imported.json()["error"]["code"] == "pose_shape_missing"


# ---------------------------------------------------------------------------
# versions + quality
# ---------------------------------------------------------------------------


def test_pose_version_snapshot_preserves_keypoints(client):
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    image = _upload_pose_ready_image(client, dataset_id)
    client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 40, "height": 50}, "keypoints": [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]}]},
    )
    version = client.post(f"/api/datasets/{dataset_id}/versions", json={"note": "pose v1"}).json()
    activated = client.post(f"/api/datasets/{dataset_id}/versions/{version['id']}/activate")
    assert activated.status_code == 200, activated.text
    annotations = client.get(f"/api/datasets/{dataset_id}/images/{image['id']}/annotations").json()
    assert annotations[0]["keypoints"] == [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]


def test_pose_quality_report_counts_pose_annotations(client):
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    image = _upload_pose_ready_image(client, dataset_id)
    client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 40, "height": 50}, "keypoints": [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]}]},
    )
    report = client.get(f"/api/datasets/{dataset_id}/quality/report").json()
    assert report["summary"]["pose_count"] == 1


# ---------------------------------------------------------------------------
# training wiring (queue disabled so no local yolo subprocess is spawned)
# ---------------------------------------------------------------------------


def test_pose_training_task_uses_pose_command_and_kpt_yaml(client, tmp_path, monkeypatch):
    monkeypatch.setattr("app.training.runtime.queue.training_queue.submit", lambda *_args, **_kwargs: None)
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    for split in ("train", "val"):
        image = _upload_pose_ready_image(client, dataset_id, split=split)
        saved = client.put(
            f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
            json={"annotations": [{"type": "pose", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 40, "height": 50}, "keypoints": [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [0.0, 0.0, 0]]}]},
        )
        assert saved.status_code == 200, saved.text

    created = client.post(
        "/api/training/tasks",
        json={"dataset_id": dataset_id, "name": "pose-run", "model": "yolov8n-pose.pt", "task_type": "pose"},
    )
    assert created.status_code == 201, created.text
    task = created.json()
    assert task["task_type"] == "pose"
    assert task["status"] == "pending"
    assert task["command_preview"].split()[1] == "pose"

    data_yaml_path = task["data_yaml_path"]
    assert data_yaml_path, task
    document = yaml.safe_load(open(data_yaml_path, encoding="utf-8"))
    assert document["kpt_shape"] == [4, 3]

    mismatch = client.post(
        "/api/training/tasks",
        json={"dataset_id": dataset_id, "name": "pose-wrong-model", "model": "yolov8n.pt", "task_type": "pose"},
    )
    assert mismatch.status_code == 422, mismatch.text
    assert mismatch.json()["error"]["code"] == "model_task_mismatch"


def test_pose_model_family_inference():
    assert infer_model_family("yolov8n-pose.pt") is TaskType.POSE
    assert infer_model_family("yolo11s_pose.yaml") is TaskType.POSE
    assert infer_model_family("yolov8n.pt") is TaskType.DETECT
    validate_model_family(TaskType.POSE, "yolov8n-pose.pt")
    with pytest.raises(Exception):
        validate_model_family(TaskType.DETECT, "yolov8n-pose.pt")
    command = build_training_command(
        task_type=TaskType.POSE, model="yolov8n-pose.pt", data_yaml="data.yaml", run_dir=str("run"),
        epochs=1, img_size=640, batch_size=1, device="cpu", workers=0, seed=42,
    )
    assert command.args[:3] == ["yolo", "pose", "train"]


# ---------------------------------------------------------------------------
# metrics + result parser + auto annotation
# ---------------------------------------------------------------------------


def test_pose_validation_metrics_parser():
    text = "\n".join(
        [
            "Class Images Instances Box P R mAP50 mAP50-95 Pose P R mAP50 mAP50-95",
            "all 4 11 0.919 0.902 0.949 0.796 0.713 0.701 0.744 0.601",
        ]
    )
    metrics = TrainingMetricsParser().parse_validation_text(text, "pose")
    assert metrics["precision"] == pytest.approx(0.919)
    assert metrics["map50_95"] == pytest.approx(0.796)
    assert metrics["pose_precision"] == pytest.approx(0.713)
    assert metrics["pose_map50_95"] == pytest.approx(0.601)


def test_pose_results_csv_aliases(tmp_path):
    results = tmp_path / "results.csv"
    results.write_text(
        "epoch,time,train/box_loss,train/pose_loss,metrics/precision(B),metrics/recall(B),metrics/mAP50(B),metrics/mAP50-95(B),metrics/pose_precision,metrics/pose_recall,metrics/pose_mAP50,metrics/pose_mAP50-95\n"
        "1,12.5,2.1,3.4,0.60,0.55,0.62,0.41,0.44,0.40,0.47,0.30\n",
        encoding="utf-8",
    )
    metrics = TrainingMetricsParser().parse_results(results)
    assert metrics["precision"] == pytest.approx(0.60)
    assert metrics["pose_precision"] == pytest.approx(0.44)
    assert metrics["pose_map50_95"] == pytest.approx(0.30)


class _FakeKeypoints:
    def __init__(self, data):
        self.data = data


class _FakeBox:
    def __init__(self):
        self.xyxy = [[10.0, 12.0, 50.0, 62.0]]
        self.cls = [0]
        self.conf = [0.9]

    def __getitem__(self, index):
        return {
            "xyxy": self.xyxy,
            "cls": self.cls,
            "conf": self.conf,
        }[index]


class _FakeBoxes(list):
    def __init__(self):
        super().__init__([_FakeBox()])


class _FakeResult:
    def __init__(self, keypoints):
        self.boxes = _FakeBoxes()
        self.obb = None
        self.masks = None
        self.keypoints = keypoints


def test_pose_result_parser_extracts_keypoints():
    keypoints = _FakeKeypoints([[[20.0, 20.0, 0.9], [40.0, 20.0, 0.3], [30.0, 50.0, 1.0]]])
    detections = YoloResultParser().parse([_FakeResult(keypoints)], "pose")
    assert len(detections) == 1
    assert detections[0].keypoints == ((20.0, 20.0, 2), (40.0, 20.0, 1), (30.0, 50.0, 2))
    assert detections[0].x == pytest.approx(10.0)
    assert detections[0].width == pytest.approx(40.0)


def test_pose_auto_annotation_persists_keypoints(client, monkeypatch):
    dataset = create_pose_dataset(client)
    dataset_id = dataset["id"]
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "person"}).json()["id"]
    image = _upload_pose_ready_image(client, dataset_id)
    from app.core.models import ModelVersion

    model_id = "model_pose_auto"
    model_path = client.app.state.storage.model_version_dir(model_id) / "best.pt"
    model_path.write_bytes(b"fake-managed-model")
    with client.app.state.database.session_factory() as session:
        session.add(ModelVersion(id=model_id, name="pose-model", version="v1", dataset_id=dataset_id, source="training_task", artifact_type="best", format="pt", task_type="pose", engine_type="ultralytics", model_path=str(model_path), status="active", metrics_json={}, notes=""))
        session.commit()

    detection = Detection(
        class_index=0, confidence=0.9, x=10, y=12, width=40, height=50,
        keypoints=((20.0, 20.0, 2), (40.0, 20.0, 2), (40.0, 50.0, 1), (30.0, 60.0, 2)),
    )
    monkeypatch.setattr("app.auto_annotation.runner.run_managed_inference", lambda **_: [detection])

    created = client.post(f"/api/datasets/{dataset_id}/auto-annotation", json={"model_id": model_id})
    assert created.status_code == 202, created.text
    task_id = created.json()["id"]
    task = None
    for _ in range(160):
        task = client.get(f"/api/auto-annotation/{task_id}").json()
        if task["status"] in {"completed", "failed", "stopped"}:
            break
        time.sleep(0.05)
    assert task is not None
    assert task["status"] == "completed", task

    annotations = client.get(f"/api/datasets/{dataset_id}/images/{image['id']}/annotations").json()
    assert len(annotations) == 1
    assert annotations[0]["type"] == "pose"
    assert annotations[0]["source"] == "auto"
    assert annotations[0]["keypoints"] == [[20.0, 20.0, 2], [40.0, 20.0, 2], [40.0, 50.0, 1], [30.0, 60.0, 2]]


def test_pose_auto_annotation_skips_keypoint_count_mismatch(client, monkeypatch):
    from app.auto_annotation.service import _annotation_from_detection
    from app.core.models import AutoAnnotationTask, ImageItem

    dataset = create_pose_dataset(client, kpt_count=4)
    dataset_id = dataset["id"]
    image = _upload_pose_ready_image(client, dataset_id)
    with client.app.state.database.session_factory() as session:
        task = AutoAnnotationTask(
            id="auto_pose_mismatch", dataset_id=dataset_id, model_id="model_x", task_type="pose",
            status="running", class_mapping={"0": "cls"},
        )
        db_image = session.get(ImageItem, image["id"])
        detection = Detection(
            class_index=0, confidence=0.9, x=10, y=12, width=40, height=50,
            keypoints=((20.0, 20.0, 2), (40.0, 20.0, 2)),
        )
        annotation = _annotation_from_detection(task, db_image, detection, "cls", "pose", pose_kpt_count=4)
        assert annotation is None
