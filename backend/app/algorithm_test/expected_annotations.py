from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from app.core.errors import ValidationError
from app.core.ids import new_id
from app.core.models import TestAnnotation, TestClassLabel, TestImage
from app.core.schemas import BBox, OBB
from app.core.task_types import annotation_type_for
from app.algorithm_test.datasets import get_test_image_in_dataset, get_test_dataset, refresh_test_dataset_counts, require_editable
from app.dataset.annotation.geometry import validate_bbox, validate_obb, validate_polygon
from app.algorithm_test.schemas import TestAnnotationInput, TestAnnotationResponse


def _response(annotation: TestAnnotation) -> TestAnnotationResponse:
    class_label = annotation.class_label
    bbox = None
    if annotation.type in {"bbox", "classify"} and annotation.x is not None:
        bbox = BBox(x=annotation.x, y=annotation.y or 0, width=annotation.width or 0, height=annotation.height or 0)
    polygon = [tuple(point) for point in annotation.polygon] if annotation.polygon else None
    obb = OBB(**annotation.obb) if annotation.type == "obb" and annotation.obb else None
    return TestAnnotationResponse(
        id=annotation.id,
        image_id=annotation.test_image_id,
        test_dataset_id=annotation.test_dataset_id,
        class_id=annotation.test_class_id,
        class_index=class_label.class_index,
        label=class_label.name,
        color=class_label.color,
        type=annotation.type,
        bbox=bbox,
        polygon=polygon,
        obb=obb,
        difficult=annotation.difficult,
        source=annotation.source,
        created_at=annotation.created_at,
        updated_at=annotation.updated_at,
    )


def list_test_annotations(session: Session, test_dataset_id: str, image_id: str) -> list[TestAnnotationResponse]:
    get_test_image_in_dataset(session, test_dataset_id, image_id)
    query = (
        select(TestAnnotation)
        .options(joinedload(TestAnnotation.class_label))
        .where(TestAnnotation.test_image_id == image_id)
        .order_by(TestAnnotation.sort_order, TestAnnotation.created_at, TestAnnotation.id)
    )
    return [_response(item) for item in session.scalars(query)]


def _validate_input(item: TestAnnotationInput, image_width: int, image_height: int) -> None:
    if item.type == "bbox" and item.bbox is not None:
        validate_bbox(item.bbox, image_width, image_height)
    elif item.type == "polygon" and item.polygon is not None:
        validate_polygon(item.polygon, image_width, image_height)
    elif item.type == "obb" and item.obb is not None:
        validate_obb(item.obb, image_width, image_height)


def replace_test_annotations(
    session: Session,
    test_dataset_id: str,
    image_id: str,
    items: list[TestAnnotationInput],
) -> list[TestAnnotationResponse]:
    """整图替换预期结果标注:几何校验复用训练标注的校验器,分类任务一张图恰好一个类别。"""

    require_editable(session, test_dataset_id)
    image = get_test_image_in_dataset(session, test_dataset_id, image_id)
    dataset = get_test_dataset(session, test_dataset_id)
    expected_type = annotation_type_for(dataset.task_type)
    if expected_type == "classify" and len(items) > 1:
        raise ValidationError("test_classify_multiple", "Classification test datasets allow exactly one expected class per image.")
    class_ids = set(
        session.scalars(select(TestClassLabel.id).where(TestClassLabel.test_dataset_id == test_dataset_id))
    )
    created: list[TestAnnotation] = []
    for sort_order, item in enumerate(items):
        if item.type != expected_type:
            raise ValidationError(
                "test_annotation_family_mismatch",
                f"{dataset.task_type} test datasets require {expected_type} annotations.",
            )
        if item.class_id not in class_ids:
            raise ValidationError("test_class_not_in_dataset", "Annotation class does not belong to this test dataset.")
        _validate_input(item, image.width, image.height)
        created.append(
            TestAnnotation(
                id=new_id("tann"),
                test_image_id=image.id,
                test_dataset_id=test_dataset_id,
                test_class_id=item.class_id,
                type=item.type,
                x=item.bbox.x if item.bbox else None,
                y=item.bbox.y if item.bbox else None,
                width=item.bbox.width if item.bbox else None,
                height=item.bbox.height if item.bbox else None,
                polygon=[list(point) for point in item.polygon] if item.polygon else None,
                obb=item.obb.model_dump() if item.obb else None,
                difficult=item.difficult,
                source="manual",
                sort_order=sort_order,
            )
        )
    session.execute(delete(TestAnnotation).where(TestAnnotation.test_image_id == image.id))
    session.add_all(created)
    image.status = "marked" if created else "unmarked"
    session.flush()
    refresh_test_dataset_counts(session, test_dataset_id)
    session.commit()
    return list_test_annotations(session, test_dataset_id, image.id)
