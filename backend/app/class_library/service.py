from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.class_library.schemas import ClassTemplateCreate, ClassTemplateUpdate
from app.class_library.translation import default_sam3_prompt
from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import ClassLabel, ClassTemplate, Dataset
from app.dataset.service import refresh_dataset_counts


def list_templates(session: Session) -> list[ClassTemplate]:
    return list(session.scalars(select(ClassTemplate).order_by(ClassTemplate.created_at)))


def create_template(session: Session, payload: ClassTemplateCreate, settings: Settings) -> ClassTemplate:
    sam3_prompt = payload.sam3_prompt
    if sam3_prompt is None:
        sam3_prompt = default_sam3_prompt(settings, payload.name)
    template = ClassTemplate(
        id=new_id("clt"),
        name=payload.name,
        color=payload.color,
        sam3_prompt=sam3_prompt,
    )
    session.add(template)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError("class_template_exists", "A class template with this name already exists.") from exc
    session.refresh(template)
    return template


def update_template(session: Session, template_id: str, payload: ClassTemplateUpdate) -> ClassTemplate:
    template = session.get(ClassTemplate, template_id)
    if template is None:
        raise NotFoundError("class_template_not_found", "Class template was not found.")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        template.name = updates["name"]
    if "color" in updates:
        template.color = updates["color"]
    if "sam3_prompt" in updates:
        template.sam3_prompt = updates["sam3_prompt"]
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError("class_template_exists", "A class template with this name already exists.") from exc
    session.refresh(template)
    return template


def delete_template(session: Session, template_id: str) -> None:
    template = session.get(ClassTemplate, template_id)
    if template is None:
        raise NotFoundError("class_template_not_found", "Class template was not found.")
    session.delete(template)
    session.commit()


def import_templates_into_dataset(
    session: Session,
    dataset_id: str,
    template_ids: list[str],
    settings: Settings,
) -> tuple[list[ClassLabel], list[str]]:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise NotFoundError("dataset_not_found", "Dataset was not found.")
    existing = set(session.scalars(
        select(ClassLabel.name).where(ClassLabel.dataset_id == dataset_id)
    ))
    imported: list[ClassLabel] = []
    skipped: list[str] = []
    max_index = session.scalar(
        select(func.max(ClassLabel.class_index)).where(ClassLabel.dataset_id == dataset_id)
    )
    next_index = -1 if max_index is None else max_index
    for template_id in template_ids:
        template = session.get(ClassTemplate, template_id)
        if template is None:
            raise NotFoundError("class_template_not_found", f"Class template {template_id} was not found.")
        if template.name in existing:
            skipped.append(template.name)
            continue
        next_index += 1
        imported.append(ClassLabel(
            id=new_id("cls"),
            dataset_id=dataset_id,
            class_index=next_index,
            name=template.name,
            color=template.color,
            sam3_prompt=_effective_prompt(settings, template, dataset),
        ))
        existing.add(template.name)
    if imported:
        session.add_all(imported)
        try:
            session.flush()
            refresh_dataset_counts(session, dataset_id)
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            raise ConflictError("class_name_exists", "A class with this name already exists.") from exc
        for item in imported:
            session.refresh(item)
    return imported, skipped


def _effective_prompt(settings: Settings, template: ClassTemplate, dataset: Dataset) -> str | None:
    if dataset.task_type != "segment":
        return None
    if template.sam3_prompt:
        return template.sam3_prompt
    return default_sam3_prompt(settings, template.name)


def update_class_label(
    session: Session,
    dataset_id: str,
    class_id: str,
    payload,
) -> ClassLabel:
    class_label = session.get(ClassLabel, class_id)
    if class_label is None or class_label.dataset_id != dataset_id:
        raise NotFoundError("class_not_found", "Class label was not found.")
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise NotFoundError("dataset_not_found", "Dataset was not found.")
    updates = payload.model_dump(exclude_unset=True)
    if "sam3_prompt" in updates and dataset.task_type != "segment":
        raise ValidationError(
            "sam3_prompt_requires_segment",
            "SAM3 提示词只对实例分割标注任务的类别生效。",
        )
    if "name" in updates:
        class_label.name = updates["name"]
    if "color" in updates:
        class_label.color = updates["color"]
    if "sam3_prompt" in updates:
        class_label.sam3_prompt = updates["sam3_prompt"]
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError("class_name_exists", "A class with this name already exists.") from exc
    session.refresh(class_label)
    return class_label
