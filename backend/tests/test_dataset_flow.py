from __future__ import annotations

import io
import zipfile
from dataclasses import replace

import pytest
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


def test_delete_dataset_removes_record_and_managed_images(client):
    dataset_id = create_dataset(client)
    upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("cat.png", png_bytes(), "image/png")},
    )
    assert upload.status_code == 201, upload.text
    dataset_dir = client.app.state.storage.dataset_dir(dataset_id)
    assert dataset_dir.is_dir()

    deleted = client.delete(f"/api/datasets/{dataset_id}")

    assert deleted.status_code == 204, deleted.text
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 404
    assert all(item["id"] != dataset_id for item in client.get("/api/datasets").json())
    assert not dataset_dir.exists()


def test_class_color_is_returned_when_annotations_are_reloaded(client):
    dataset_id = create_dataset(client)
    created = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat", "color": "#ef4444"})
    assert created.status_code == 201, created.text
    class_id = created.json()["id"]
    created_second = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "dog", "color": "#22c55e"})
    assert created_second.status_code == 201, created_second.text

    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("cat.png", png_bytes(), "image/png")},
    ).json()["items"][0]
    saved = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 30, "height": 25}}]},
    )
    assert saved.status_code == 200, saved.text

    classes = client.get(f"/api/datasets/{dataset_id}/classes")
    annotations = client.get(f"/api/datasets/{dataset_id}/images/{image['id']}/annotations")

    assert classes.status_code == 200, classes.text
    assert [(item["name"], item["color"]) for item in classes.json()] == [("cat", "#ef4444"), ("dog", "#22c55e")]
    assert annotations.status_code == 200, annotations.text
    assert annotations.json()[0]["label"] == "cat"
    assert annotations.json()[0]["color"] == "#ef4444"


def test_detect_dataset_annotation_validation_and_yolo_round_trip(client):
    dataset_id = create_dataset(client)
    class_response = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat", "color": "#ff0000"})
    assert class_response.status_code == 201, class_response.text
    class_id = class_response.json()["id"]

    upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        data={"split": "val"},
        files={"files": ("cat.png", png_bytes(), "image/png")},
    )
    assert upload.status_code == 201, upload.text
    image = upload.json()["items"][0]
    assert image["split"] == "val"

    annotations = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 30, "height": 25}}]},
    )
    assert annotations.status_code == 200, annotations.text
    assert annotations.json()[0]["bbox"] == {"x": 10.0, "y": 12.0, "width": 30.0, "height": 25.0}

    validation = client.post(f"/api/datasets/{dataset_id}/validate")
    assert validation.status_code == 200, validation.text
    assert validation.json()["valid"] is True

    image_response = client.get(image["file_url"])
    assert image_response.status_code == 200
    assert image_response.headers["content-type"] == "image/png"

    exported = client.get(f"/api/datasets/{dataset_id}/export/yolo")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = set(archive.namelist())
        assert "data.yaml" in names
        assert any(name.startswith("images/val/") for name in names)
        label_name = next(name for name in names if name.startswith("labels/val/"))
        assert label_name.endswith(".txt")
        assert archive.read(label_name).decode().startswith("0 0.25")

    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "round-trip", "task_type": "detect"},
        files={"file": ("export.zip", exported.content, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["imported_images"] == 1
    assert imported.json()["imported_annotations"] == 1
    assert imported.json()["dataset"]["annotated_image_count"] == 1


def test_quality_report_and_deterministic_bulk_splits(client):
    dataset_id = create_dataset(client)
    class_a = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "a"}).json()["id"]
    client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "b"})
    images = []
    for index in range(5):
        response = client.post(f"/api/datasets/{dataset_id}/images/upload", files={"files": (f"{index}.png", png_bytes(), "image/png")})
        images.append(response.json()["items"][0])
    client.put(f"/api/datasets/{dataset_id}/images/{images[0]['id']}/annotations", json={"annotations": [
        {"type": "bbox", "class_id": class_a, "bbox": {"x": 10, "y": 10, "width": 10, "height": 10}},
        {"type": "bbox", "class_id": class_a, "bbox": {"x": 10.2, "y": 10.2, "width": 10, "height": 10}},
    ]})
    report = client.get(f"/api/datasets/{dataset_id}/quality/report")
    assert report.status_code == 200
    assert report.json()["summary"]["image_count"] == 5
    assert report.json()["summary"]["small_object_count"] == 2
    assert {item["type"] for item in report.json()["issues"]} >= {"small_object", "similar_bbox"}

    bulk = client.post(f"/api/datasets/{dataset_id}/images/bulk-split", json={"image_ids": [images[0]["id"], images[1]["id"]], "split": "val"})
    assert bulk.status_code == 200
    assert bulk.json()["updated"] == 2
    split = client.post(f"/api/datasets/{dataset_id}/images/auto-split", json={"train_ratio": 0.8, "val_ratio": 0.2, "test_ratio": 0, "seed": 42})
    assert split.status_code == 200
    assert split.json()["split_counts"] == {"train": 4, "val": 1, "test": 0}


def test_coco_round_trip_and_derived_tiling_dataset(client):
    dataset_id = create_dataset(client)
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        data={"split": "val"},
        files={"files": ("large.png", png_bytes(size=(300, 200)), "image/png")},
    ).json()["items"][0]
    client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "bbox", "class_id": class_id, "bbox": {"x": 10, "y": 12, "width": 30, "height": 25}}]},
    )
    coco = client.get(f"/api/datasets/{dataset_id}/export/coco")
    assert coco.status_code == 200, coco.text
    with zipfile.ZipFile(io.BytesIO(coco.content)) as archive:
        manifest = __import__("json").loads(archive.read("annotations.json"))
        assert manifest["images"][0]["split"] == "val"
        assert manifest["images"][0]["file_name"] in archive.namelist()
        assert manifest["images"][0]["starter_original_file_name"] == "large.png"
        assert manifest["annotations"][0]["bbox"] == [10.0, 12.0, 30.0, 25.0]
    imported = client.post(
        "/api/datasets/import/coco",
        data={"name": "coco-round-trip", "task_type": "detect"},
        files={"file": ("coco.zip", coco.content, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["imported_annotations"] == 1
    imported_image = client.get(f"/api/datasets/{imported.json()['dataset']['id']}/images").json()["items"][0]
    assert imported_image["file_name"] == "large.png"

    tiled = client.post(
        f"/api/datasets/{dataset_id}/tile",
        json={"name": "tiled", "tile_size": 128, "overlap": 0, "keep_empty_tiles": False},
    )
    assert tiled.status_code == 201, tiled.text
    assert tiled.json()["generated_images"] == 1
    detail = client.get(f"/api/datasets/{tiled.json()['dataset_id']}")
    assert detail.status_code == 200
    assert detail.json()["task_type"] == "detect"


def test_coco_segment_import_rejects_bbox_only_annotations(client):
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("annotations.json", __import__("json").dumps({
            "categories": [{"id": 1, "name": "shape"}],
            "images": [{"id": 1, "file_name": "images/shape.png", "width": 100, "height": 80}],
            "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "bbox": [10, 10, 20, 20], "segmentation": []}],
        }))
        archive.writestr("images/shape.png", png_bytes())
    response = client.post(
        "/api/datasets/import/coco",
        data={"name": "invalid-segment-coco", "task_type": "segment"},
        files={"file": ("segment.zip", archive_payload.getvalue(), "application/zip")},
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "coco_segment_missing_polygon"


def test_failed_coco_import_rolls_back_dataset_and_classes(client):
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("annotations.json", __import__("json").dumps({
            "categories": [{"id": 1, "name": "shape"}],
            "images": [{"id": 1, "file_name": "images/missing.png", "width": 100, "height": 80}],
            "annotations": [],
        }))
    before = client.get("/api/datasets").json()
    response = client.post(
        "/api/datasets/import/coco",
        data={"name": "must-rollback", "task_type": "detect"},
        files={"file": ("broken.zip", archive_payload.getvalue(), "application/zip")},
    )
    assert response.status_code == 422
    after = client.get("/api/datasets").json()
    assert [item["id"] for item in after] == [item["id"] for item in before]


def test_segment_annotations_require_polygon_and_reject_out_of_bounds(client):
    dataset_id = create_dataset(client, "segment")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "shape"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("shape.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    rejected = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "polygon", "class_id": class_id, "polygon": [[-1, 1], [20, 1], [20, 20]]}]},
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "polygon_out_of_bounds"

    saved = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "polygon", "class_id": class_id, "polygon": [[10, 10], [60, 10], [60, 50], [10, 50]]}]},
    )
    assert saved.status_code == 200, saved.text


def test_obb_annotations_validate_and_round_trip_through_yolo(client):
    dataset_id = create_dataset(client, "obb")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "vehicle"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        data={"split": "val"},
        files={"files": ("vehicle.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    saved = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={
            "annotations": [
                {"type": "obb", "class_id": class_id, "obb": {"cx": 45, "cy": 35, "width": 30, "height": 20, "angle": 20}}
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()[0]["obb"] == {"cx": 45.0, "cy": 35.0, "width": 30.0, "height": 20.0, "angle": 20.0}

    exported = client.get(f"/api/datasets/{dataset_id}/export/yolo")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        label_name = next(name for name in archive.namelist() if name.startswith("labels/val/"))
        assert len(archive.read(label_name).decode().strip().split()) == 9

    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "obb-round-trip", "task_type": "obb"},
        files={"file": ("obb.zip", exported.content, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["imported_annotations"] == 1


def test_obb_annotation_allows_right_angle_image_boundary_without_float_error(client):
    dataset_id = create_dataset(client, "obb")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "vehicle"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("vehicle.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    response = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={
            "annotations": [
                {"type": "obb", "class_id": class_id, "obb": {"cx": 30, "cy": 40, "width": 80, "height": 60, "angle": -90}}
            ]
        },
    )

    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    ("label", "message"),
    [
        ("0 0.10 0.10 0.50 0.10 0.40 0.50 0.10 0.40", "an ordered rectangle"),
        ("0 -0.01 0.10 0.50 0.10 0.50 0.50 0.10 0.50", "normalized to the [0, 1] range"),
    ],
)
def test_obb_yolo_import_rejects_non_rectangular_or_out_of_range_corners(client, label, message):
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("data.yaml", "names: [vehicle]\n")
        archive.writestr("images/train/vehicle.png", png_bytes())
        archive.writestr("labels/train/vehicle.txt", f"{label}\n")

    response = client.post(
        "/api/datasets/import/yolo",
        data={"name": "invalid-obb", "task_type": "obb"},
        files={"file": ("invalid-obb.zip", archive_payload.getvalue(), "application/zip")},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "invalid_obb_label"
    assert message in response.json()["error"]["message"]


@pytest.mark.parametrize(
    ("settings", "members", "expected_code"),
    [
        ({"max_yolo_archive_members": 2}, [("data.yaml", b"names: [object]\n"), ("images/train/object.png", png_bytes()), ("labels/train/object.txt", b"0 0.5 0.5 0.2 0.2\n")], "archive_too_many_members"),
        ({"max_yolo_archive_member_bytes": 32}, [("payload.bin", b"x" * 33)], "archive_member_too_large"),
        ({"max_yolo_archive_uncompressed_bytes": 64}, [("first.bin", b"x" * 32), ("second.bin", b"x" * 33)], "archive_total_too_large"),
    ],
)
def test_yolo_import_rejects_archive_count_and_size_limits(client, settings, members, expected_code):
    client.app.state.settings = replace(client.app.state.settings, **settings)
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members:
            archive.writestr(name, content)

    response = client.post(
        "/api/datasets/import/yolo",
        data={"name": "limited", "task_type": "detect"},
        files={"file": ("limited.zip", archive_payload.getvalue(), "application/zip")},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == expected_code


def test_yolo_import_rejects_excessive_compression_ratio_before_extracting_members(client):
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("highly-compressible.bin", b"0" * (256 * 1024))

    response = client.post(
        "/api/datasets/import/yolo",
        data={"name": "zip-bomb", "task_type": "detect"},
        files={"file": ("zip-bomb.zip", archive_payload.getvalue(), "application/zip")},
    )

    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "archive_compression_ratio_exceeded"


def test_classification_uses_yolo_class_directories(client):
    dataset_id = create_dataset(client, "classify")
    cat_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"}).json()["id"]
    dog_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "dog"}).json()["id"]
    images = []
    for split in ("train", "val"):
        response = client.post(
            f"/api/datasets/{dataset_id}/images/upload",
            data={"split": split},
            files={"files": (f"{split}.png", png_bytes(), "image/png")},
        )
        images.append(response.json()["items"][0])
    for image, class_id in zip(images, (cat_id, dog_id), strict=True):
        response = client.put(
            f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
            json={"annotations": [{"type": "classify", "class_id": class_id}]},
        )
        assert response.status_code == 200, response.text

    exported = client.get(f"/api/datasets/{dataset_id}/export/yolo")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = set(archive.namelist())
        assert "data.yaml" not in names
        assert any(name.startswith("train/cat/") for name in names)
        assert any(name.startswith("val/dog/") for name in names)

    imported = client.post(
        "/api/datasets/import/yolo",
        data={"name": "classify-round-trip", "task_type": "classify"},
        files={"file": ("classify.zip", exported.content, "application/zip")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["imported_images"] == 2
    assert imported.json()["imported_annotations"] == 2


def test_sam_box_assist_returns_a_reviewable_polygon(client):
    dataset_id = create_dataset(client, "segment")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "object"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("object.png", png_bytes(), "image/png")},
    ).json()["items"][0]
    suggestion = client.post(
        "/api/sam/predict",
        json={"image_id": image["id"], "class_id": class_id, "prompt_type": "box", "box": {"x": 10, "y": 12, "width": 30, "height": 25}},
    )
    assert suggestion.status_code == 200, suggestion.text
    payload = suggestion.json()
    assert payload["backend_used"] == "box_stub"
    assert payload["polygons"] == [[[10.0, 12.0], [40.0, 12.0], [40.0, 37.0], [10.0, 37.0]]]

    saved = client.put(
        f"/api/datasets/{dataset_id}/images/{image['id']}/annotations",
        json={"annotations": [{"type": "polygon", "class_id": class_id, "polygon": payload["polygons"][0], "source": "sam"}]},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()[0]["source"] == "sam"


def test_system_info_reports_sam_capabilities_without_exposing_model_reference(client):
    unavailable = client.get("/api/system/info")
    assert unavailable.status_code == 200, unavailable.text
    assert unavailable.json()["sam"] == {
        "model_configured": False,
        "box_prompt_available": True,
        "point_prompt_available": False,
        "box_backend": "box_stub",
    }

    client.app.state.settings = replace(client.app.state.settings, sam_model="/private/checkpoints/sam_b.pt")
    configured = client.get("/api/system/info")
    assert configured.status_code == 200, configured.text
    assert configured.json()["sam"] == {
        "model_configured": True,
        "box_prompt_available": True,
        "point_prompt_available": True,
        "box_backend": "ultralytics_sam",
    }
    assert "/private/checkpoints/sam_b.pt" not in configured.text


def test_sam_uses_configured_ultralytics_model(client, monkeypatch):
    dataset_id = create_dataset(client, "segment")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "object"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("object.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    class FakePolygon:
        def tolist(self):
            return [[12, 12], [40, 12], [40, 35], [12, 35]]

    class FakeMasks:
        xy = [FakePolygon()]

        class data:
            device = "mps"

    class FakeResults:
        masks = FakeMasks()

    class FakeSam:
        def predict(self, **kwargs):
            assert kwargs["bboxes"] == [[10, 12, 40, 37]]
            return [FakeResults()]

    client.app.state.settings = replace(client.app.state.settings, sam_model="fake-sam.pt")
    monkeypatch.setattr("app.sam.service._model_for", lambda _: FakeSam())
    suggestion = client.post(
        "/api/sam/predict",
        json={"image_id": image["id"], "class_id": class_id, "prompt_type": "box", "box": {"x": 10, "y": 12, "width": 30, "height": 25}},
    )
    assert suggestion.status_code == 200, suggestion.text
    assert suggestion.json()["backend_used"] == "ultralytics_sam"
    assert suggestion.json()["polygons"] == [[[12.0, 12.0], [40.0, 12.0], [40.0, 35.0], [12.0, 35.0]]]
    assert suggestion.json()["device"] == "mps"


def test_sam_remote_box_prompt_scopes_inference_to_the_box(client, monkeypatch):
    dataset_id = create_dataset(client, "segment")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "truck"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("truck.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    calls: list[tuple[str, str, object]] = []

    def fake_predict(base_url, image_path, prompt_text, box=None):
        calls.append((base_url, prompt_text, box))
        return [[(12.0, 12.0), (40.0, 12.0), (40.0, 35.0), (12.0, 35.0)]], 0.87, "remote"

    monkeypatch.setattr("app.sam.service._predict_with_remote", fake_predict)
    client.app.state.settings = replace(client.app.state.settings, sam_backend="http://sam3.test:8001")

    suggestion = client.post(
        "/api/sam/predict",
        json={"image_id": image["id"], "class_id": class_id, "prompt_type": "box", "box": {"x": 10, "y": 12, "width": 30, "height": 25}},
    )
    assert suggestion.status_code == 200, suggestion.text
    payload = suggestion.json()
    assert payload["backend_used"] == "remote-sam3"
    assert payload["score"] == 0.87
    assert payload["polygons"] == [[[12.0, 12.0], [40.0, 12.0], [40.0, 35.0], [12.0, 35.0]]]
    assert len(calls) == 1
    base_url, prompt_text, box = calls[0]
    assert base_url == "http://sam3.test:8001"
    assert prompt_text == "truck"
    assert (box.x, box.y, box.width, box.height) == (10, 12, 30, 25)


def test_sam_remote_point_prompt_returns_all_instances(client, monkeypatch):
    dataset_id = create_dataset(client, "segment")
    class_id = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "truck"}).json()["id"]
    image = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("truck.png", png_bytes(), "image/png")},
    ).json()["items"][0]

    left = [(5.0, 5.0), (25.0, 5.0), (25.0, 20.0), (5.0, 20.0)]
    right = [(60.0, 5.0), (80.0, 5.0), (80.0, 20.0), (60.0, 20.0)]

    def fake_predict(base_url, image_path, prompt_text, box=None):
        assert box is None
        return [left, right], 0.9, "remote"

    monkeypatch.setattr("app.sam.service._predict_with_remote", fake_predict)
    client.app.state.settings = replace(client.app.state.settings, sam_backend="http://sam3.test:8001")

    suggestion = client.post(
        "/api/sam/predict",
        json={"image_id": image["id"], "class_id": class_id, "prompt_type": "point", "points": [{"x": 15, "y": 10, "label": 1}]},
    )
    assert suggestion.status_code == 200, suggestion.text
    payload = suggestion.json()
    assert payload["backend_used"] == "remote-sam3"
    assert payload["polygons"] == [
        [[5.0, 5.0], [25.0, 5.0], [25.0, 20.0], [5.0, 20.0]],
        [[60.0, 5.0], [80.0, 5.0], [80.0, 20.0], [60.0, 20.0]],
    ]


def test_scan_path_is_restricted_to_import_root(client, tmp_path):
    dataset_id = create_dataset(client)
    response = client.post(f"/api/datasets/{dataset_id}/images/scan", json={"path": "../", "recursive": True, "split": "train"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "import_path_outside_root"


def test_scan_does_not_follow_file_symlink_outside_import_root(client, tmp_path):
    dataset_id = create_dataset(client)
    external_image = tmp_path / "outside.png"
    external_image.write_bytes(png_bytes())
    import_root = tmp_path / "imports"
    import_root.mkdir(exist_ok=True)
    link = import_root / "linked-outside.png"
    try:
        link.symlink_to(external_image)
    except OSError as exc:
        pytest.skip(f"symlinks are not available in this environment: {exc}")

    response = client.post(
        f"/api/datasets/{dataset_id}/images/scan",
        json={"path": ".", "recursive": True, "split": "train"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"total_found": 1, "imported": 0, "skipped": 0, "invalid": 1}
    assert client.get(f"/api/datasets/{dataset_id}/images").json()["total"] == 0


def test_import_images_from_source_dataset(client):
    source = client.post("/api/source-datasets", json={"name": "白天抓拍"}).json()
    uploaded = client.post(
        f"/api/source-datasets/{source['id']}/images/upload",
        files=[
            ("files", ("day1.png", png_bytes("#eeeeee"), "image/png")),
            ("files", ("night1.png", png_bytes("#222222"), "image/png")),
        ],
    )
    assert uploaded.status_code == 201, uploaded.text
    tag = client.post(f"/api/source-datasets/{source['id']}/tags", json={"name": "白天"}).json()
    items = client.get(f"/api/source-datasets/{source['id']}/images").json()["items"]
    day = next(item for item in items if item["file_name"] == "day1.png")
    patched = client.patch(f"/api/source-datasets/{source['id']}/images/{day['id']}", json={"tag_ids": [tag["id"]]})
    assert patched.status_code == 200, patched.text

    dataset_id = create_dataset(client)
    filtered = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"], "tag_ids": [tag["id"]], "split": "val"},
    )
    assert filtered.status_code == 201, filtered.text
    assert filtered.json() == {"imported": 1, "skipped": 0}
    imported = client.get(f"/api/datasets/{dataset_id}/images").json()
    assert imported["total"] == 1
    assert imported["items"][0]["file_name"] == "day1.png"
    assert imported["items"][0]["split"] == "val"
    assert client.get(f"/api/source-datasets/{source['id']}/images").json()["total"] == 2

    missing = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"], "image_ids": ["simg_missing"]},
    )
    assert missing.status_code == 404

    night_tag = client.post(f"/api/source-datasets/{source['id']}/tags", json={"name": "夜间"}).json()
    night = next(item for item in items if item["file_name"] == "night1.png")
    client.patch(f"/api/source-datasets/{source['id']}/images/{night['id']}", json={"tag_ids": [night_tag["id"]]})
    any_import = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"], "tag_ids": [tag["id"], night_tag["id"]], "tag_match": "any"},
    )
    assert any_import.status_code == 201, any_import.text
    assert any_import.json() == {"imported": 2, "skipped": 0}
    all_import = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"], "tag_ids": [tag["id"], night_tag["id"]], "tag_match": "all"},
    )
    assert all_import.status_code == 201, all_import.text
    assert all_import.json() == {"imported": 0, "skipped": 0}

    everything = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"]},
    )
    assert everything.status_code == 201, everything.text
    assert everything.json() == {"imported": 2, "skipped": 0}


def test_import_images_from_source_with_tag_values(client):
    source = client.post("/api/source-datasets", json={"name": "取值同步"}).json()
    uploaded = client.post(
        f"/api/source-datasets/{source['id']}/images/upload",
        files=[
            ("files", ("strong1.png", png_bytes("#eeeeee"), "image/png")),
            ("files", ("weak1.png", png_bytes("#222222"), "image/png")),
        ],
    )
    assert uploaded.status_code == 201, uploaded.text
    tag = client.post(f"/api/source-datasets/{source['id']}/tags", json={"name": "光线", "values": ["强", "弱"]}).json()
    items = client.get(f"/api/source-datasets/{source['id']}/images").json()["items"]
    for file_name, value in (("strong1.png", "强"), ("weak1.png", "弱")):
        image = next(item for item in items if item["file_name"] == file_name)
        patched = client.patch(
            f"/api/source-datasets/{source['id']}/images/{image['id']}",
            json={"tag_ids": [tag["id"]], "tag_values": {tag["id"]: value}},
        )
        assert patched.status_code == 200, patched.text

    dataset_id = create_dataset(client)
    strong = client.post(
        f"/api/datasets/{dataset_id}/images/from-source",
        json={"source_dataset_id": source["id"], "tag_ids": [tag["id"]], "tag_values": {tag["id"]: "强"}},
    )
    assert strong.status_code == 201, strong.text
    assert strong.json() == {"imported": 1, "skipped": 0}
    names = {item["file_name"] for item in client.get(f"/api/datasets/{dataset_id}/images").json()["items"]}
    assert names == {"strong1.png"}


def test_image_thumbnail_is_generated_and_cached(client):
    dataset_id = create_dataset(client)
    upload = client.post(
        f"/api/datasets/{dataset_id}/images/upload",
        files={"files": ("big.png", png_bytes(size=(1200, 900)), "image/png")},
    )
    assert upload.status_code == 201, upload.text
    image_id = upload.json()["items"][0]["id"]

    first = client.get(f"/api/images/{image_id}/thumbnail")
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/jpeg"

    thumbnail = client.app.state.storage.dataset_dir(dataset_id) / "thumbs" / f"{image_id}.jpg"
    assert thumbnail.is_file()
    with Image.open(thumbnail) as rendered:
        assert max(rendered.size) <= 320
        assert rendered.format == "JPEG"

    # 二次请求命中磁盘缓存
    again = client.get(f"/api/images/{image_id}/thumbnail")
    assert again.status_code == 200
    assert again.content == first.content


def test_import_zip_from_ftp(client, monkeypatch):
    import json as jsonlib

    from app.ftp.service import FtpService

    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("annotations.json", jsonlib.dumps({
            "categories": [{"id": 1, "name": "shape"}],
            "images": [{"id": 1, "file_name": "images/shape.png", "width": 100, "height": 80}],
            "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "bbox": [10, 10, 20, 20], "segmentation": []}],
        }))
        archive.writestr("images/shape.png", png_bytes())
    monkeypatch.setattr(FtpService, "download", lambda self, path: ("ds.zip", archive_payload.getvalue()))

    created = client.post(
        "/api/datasets/import/from-ftp",
        json={"path": "/export/ds.zip", "name": "ftp-coco", "task_type": "detect", "format": "coco"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["imported_images"] == 1
    assert body["imported_annotations"] == 1
    assert body["dataset"]["name"] == "ftp-coco"

    not_zip = client.post(
        "/api/datasets/import/from-ftp",
        json={"path": "/export/ds.tar", "name": "ftp-bad", "task_type": "detect", "format": "coco"},
    )
    assert not_zip.status_code == 422, not_zip.text
    assert not_zip.json()["error"]["code"] == "ftp_import_not_zip"


def _wait_import_settled(client, dataset_id: str) -> dict:
    import time as timelib

    for _ in range(100):
        detail = client.get(f"/api/datasets/{dataset_id}")
        assert detail.status_code == 200, detail.text
        body = detail.json()
        if body.get("import_state") in ("completed", "failed", "stopped"):
            return body
        timelib.sleep(0.05)
    raise AssertionError("async import did not settle")


def test_async_ftp_import_shows_progress_then_completes(client, monkeypatch):
    import json as jsonlib

    from app.ftp.service import FtpService

    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("annotations.json", jsonlib.dumps({
            "categories": [{"id": 1, "name": "shape"}],
            "images": [{"id": 1, "file_name": "images/shape.png", "width": 100, "height": 80}],
            "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "bbox": [10, 10, 20, 20], "segmentation": []}],
        }))
        archive.writestr("images/shape.png", png_bytes())
    payload = archive_payload.getvalue()

    def fake_download(self, path, on_progress=None):
        if on_progress is not None:
            on_progress(len(payload) // 2, len(payload))
        return "ds.zip", payload

    monkeypatch.setattr(FtpService, "download_with_progress", fake_download)

    started = client.post(
        "/api/datasets/import/from-ftp?wait=false",
        json={"path": "/export/ds.zip", "name": "async-ftp", "task_type": "detect", "format": "coco"},
    )
    assert started.status_code == 201, started.text
    body = started.json()["dataset"]
    assert body["import_state"] == "importing"
    dataset_id = body["id"]

    settled = _wait_import_settled(client, dataset_id)
    assert settled["import_state"] == "completed", settled.get("import_message")
    assert settled["import_progress"] == 100.0
    assert settled["image_count"] == 1


def test_async_import_failure_is_reported_on_dataset(client, monkeypatch):
    from app.ftp.service import FtpService

    monkeypatch.setattr(FtpService, "download_with_progress", lambda self, path, on_progress=None: ("bad.zip", b"not a zip"))
    started = client.post(
        "/api/datasets/import/from-ftp?wait=false",
        json={"path": "/export/bad.zip", "name": "async-bad", "task_type": "detect", "format": "coco"},
    )
    assert started.status_code == 201, started.text
    dataset_id = started.json()["dataset"]["id"]

    settled = _wait_import_settled(client, dataset_id)
    assert settled["import_state"] == "failed"
    assert settled["import_message"]


def test_async_import_can_be_cancelled(client, monkeypatch):
    import threading as threadinglib

    from app.ftp.service import FtpService

    download_started = threadinglib.Event()
    release_download = threadinglib.Event()

    def fake_download(self, path, on_progress=None):
        download_started.set()
        release_download.wait(timeout=10)
        return "big.zip", b"not a zip"

    monkeypatch.setattr(FtpService, "download_with_progress", fake_download)

    started = client.post(
        "/api/datasets/import/from-ftp?wait=false",
        json={"path": "/export/big.zip", "name": "cancel-me", "task_type": "detect", "format": "coco"},
    )
    assert started.status_code == 201, started.text
    dataset_id = started.json()["dataset"]["id"]
    assert download_started.wait(5)

    cancelled = client.post(f"/api/datasets/{dataset_id}/import/cancel")
    assert cancelled.status_code == 200, cancelled.text
    release_download.set()

    settled = _wait_import_settled(client, dataset_id)
    assert settled["import_state"] == "stopped"
    assert "停止" in (settled["import_message"] or "")

    again = client.post(f"/api/datasets/{dataset_id}/import/cancel")
    assert again.status_code == 422
    assert again.json()["error"]["code"] == "import_not_running"


def _yolo_zip(label_line: bytes) -> bytes:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("data.yaml", b"names: [object]\n")
        zf.writestr("images/train/object.png", png_bytes())
        zf.writestr("labels/train/object.txt", label_line)
    return archive.getvalue()


def test_yolo_import_clamps_slightly_overflowing_bbox(client):
    payload = _yolo_zip(b"0 0.5 0.5 1.015 1.015\n")
    response = client.post(
        "/api/datasets/import/yolo",
        data={"name": "clamp-edge", "task_type": "detect"},
        files={"file": ("a.zip", payload, "application/zip")},
    )
    assert response.status_code == 201, response.text
    assert response.json()["imported_annotations"] == 1


def test_yolo_import_rejects_severely_overflowing_bbox_with_context(client):
    payload = _yolo_zip(b"0 0.6 0.6 1.2 1.2\n")
    response = client.post(
        "/api/datasets/import/yolo",
        data={"name": "overflow", "task_type": "detect"},
        files={"file": ("a.zip", payload, "application/zip")},
    )
    assert response.status_code == 422, response.text
    message = response.json()["error"]["message"]
    assert "labels/train/object.txt" in message
    assert "image 100x80" in message


def _merge_zip() -> bytes:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("data.yaml", "names: [cat, dog]\n")
        zf.writestr("images/train/cat1.png", png_bytes("#aa1122"))
        zf.writestr("labels/train/cat1.txt", "0 0.5 0.5 0.4 0.4\n")
        zf.writestr("images/val/dog1.png", png_bytes("#2233aa"))
        zf.writestr("labels/val/dog1.txt", "1 0.4 0.4 0.2 0.2\n")
    return archive.getvalue()


def _wait_merge_settled(client, dataset_id: str) -> dict:
    import time as timelib

    for _ in range(100):
        body = client.get(f"/api/datasets/{dataset_id}").json()
        state = body.get("import_state")
        if state != "merging":
            return body
        timelib.sleep(0.05)
    raise AssertionError(f"merge did not settle, last state: {body.get('import_state')} {body.get('import_message')}")


def test_merge_yolo_zip_into_existing_dataset(client):
    dataset_id = create_dataset(client)
    created = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "cat"})
    assert created.status_code == 201, created.text

    started = client.post(
        f"/api/datasets/{dataset_id}/images/upload-yolo",
        files={"file": ("merge.zip", _merge_zip(), "application/zip")},
    )
    assert started.status_code == 201, started.text
    assert started.json()["dataset"]["import_state"] == "merging"

    settled = _wait_merge_settled(client, dataset_id)
    assert settled["import_state"] is None, settled.get("import_message")
    assert settled["image_count"] == 2
    classes = client.get(f"/api/datasets/{dataset_id}/classes").json()
    assert sorted(item["name"] for item in classes) == ["cat", "dog"]

    # 同名图片再次合并：全部跳过，不产生重复
    again = client.post(
        f"/api/datasets/{dataset_id}/images/upload-yolo",
        files={"file": ("merge.zip", _merge_zip(), "application/zip")},
    )
    assert again.status_code == 201, again.text
    settled2 = _wait_merge_settled(client, dataset_id)
    assert settled2["import_state"] is None
    assert settled2["image_count"] == 2


def test_merge_failure_marks_dataset_but_keeps_it_usable(client):
    dataset_id = create_dataset(client)
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("annotations.json", "{}")
    started = client.post(
        f"/api/datasets/{dataset_id}/images/upload-yolo",
        files={"file": ("bad.zip", bad.getvalue(), "application/zip")},
    )
    assert started.status_code == 201, started.text
    settled = _wait_merge_settled(client, dataset_id)
    assert settled["import_state"] == "merge_failed"
    assert settled["import_message"]
    # 数据集本身仍可用：可继续新增类别
    ok = client.post(f"/api/datasets/{dataset_id}/classes", json={"name": "still-alive"})
    assert ok.status_code == 201, ok.text


def _ftp_tree_fixture() -> dict:
    return {
        "export-v3/data.yaml": b"names: [cat]\n",
        "export-v3/images/train/cat2.png": png_bytes("#1122aa"),
        "export-v3/labels/train/cat2.txt": b"0 0.5 0.5 0.4 0.4\n",
    }


def test_async_import_from_ftp_directory(client, monkeypatch):
    from app.ftp.service import FtpService

    tree = _ftp_tree_fixture()

    def fake_tree(self, path, *, recursive, max_bytes, max_files=None, on_progress=None):
        assert recursive is True
        return dict(tree), False, 0

    monkeypatch.setattr(FtpService, "fetch_yolo_tree", fake_tree)

    started = client.post(
        "/api/datasets/import/from-ftp?wait=false",
        json={"path": "/export/export-v3", "name": "ftp-dir", "task_type": "detect", "format": "yolo", "source": "dir"},
    )
    assert started.status_code == 201, started.text
    dataset_id = started.json()["dataset"]["id"]
    settled = _wait_import_settled(client, dataset_id)
    assert settled["import_state"] == "completed", settled.get("import_message")
    assert settled["image_count"] == 1


def test_merge_from_ftp_directory_into_existing(client, monkeypatch):
    from app.ftp.service import FtpService

    tree = _ftp_tree_fixture()
    monkeypatch.setattr(FtpService, "fetch_yolo_tree", lambda self, path, *, recursive, max_bytes, max_files=None, on_progress=None: (dict(tree), False, 0))

    dataset_id = create_dataset(client)
    started = client.post(
        f"/api/datasets/{dataset_id}/images/merge-from-ftp",
        json={"path": "/export/export-v3", "source": "dir"},
    )
    assert started.status_code == 201, started.text
    settled = _wait_merge_settled(client, dataset_id)
    assert settled["import_state"] is None, settled.get("import_message")
    assert settled["image_count"] == 1
    classes = client.get(f"/api/datasets/{dataset_id}/classes").json()
    assert [item["name"] for item in classes] == ["cat"]
