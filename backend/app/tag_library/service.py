from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.ids import new_id
from app.core.models import TagTemplate, SourceTag
from app.tag_library.schemas import TagTemplateCreate, TagTemplateOut, TagTemplateUpdate


def list_templates(session: Session) -> list[TagTemplateOut]:
    rows = session.scalars(select(TagTemplate).order_by(TagTemplate.name)).all()
    return [TagTemplateOut.model_validate(row) for row in rows]


def create_template(session: Session, payload: TagTemplateCreate) -> TagTemplateOut:
    template = TagTemplate(
        id=new_id("tagtpl"),
        name=payload.name,
        color=payload.color,
        values=payload.values,
        description=payload.description,
    )
    session.add(template)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise ConflictError("tag_template_conflict", "同名标签已存在。") from None
    session.refresh(template)
    return TagTemplateOut.model_validate(template)


def update_template(session: Session, template_id: str, payload: TagTemplateUpdate) -> TagTemplateOut:
    template = session.get(TagTemplate, template_id)
    if template is None:
        raise NotFoundError("tag_template_not_found", "标签不存在。")
    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(template, field, value)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise ConflictError("tag_template_conflict", "同名标签已存在。") from None
    session.refresh(template)
    return TagTemplateOut.model_validate(template)


def delete_template(session: Session, template_id: str) -> None:
    template = session.get(TagTemplate, template_id)
    if template is None:
        raise NotFoundError("tag_template_not_found", "标签不存在。")
    session.delete(template)
    session.commit()


def sync_to_dataset(session: Session, source_dataset_id: str) -> list[TagTemplateOut]:
    """把标签库同步到某数据源:库内每个标签确保存在同名 source tag(含枚举值)。"""
    from app.core.models import SourceDataset

    dataset = session.get(SourceDataset, source_dataset_id)
    if dataset is None:
        raise NotFoundError("source_dataset_not_found", "数据源不存在。")
    templates = list(session.scalars(select(TagTemplate).order_by(TagTemplate.name)))
    existing = {tag.name: tag for tag in session.scalars(select(SourceTag).where(SourceTag.source_dataset_id == source_dataset_id))}
    for template in templates:
        found = existing.get(template.name)
        if found is None:
            session.add(SourceTag(id=new_id("stag"), source_dataset_id=source_dataset_id, name=template.name, color=template.color, values=template.values))
        else:
            found.color = template.color
            found.values = template.values
    if templates:
        session.commit()
    return [TagTemplateOut.model_validate(item) for item in templates]
