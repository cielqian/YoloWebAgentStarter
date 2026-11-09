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


def _validated_material_types(session: Session, names: list[str] | None) -> list[str] | None:
    """校验素材类型名称存在于库;空列表归一为 None。"""
    if not names:
        return None
    from app.material_type.service import validate_names

    return validate_names(session, names)


def create_template(session: Session, payload: TagTemplateCreate) -> TagTemplateOut:
    template = TagTemplate(
        id=new_id("tagtpl"),
        name=payload.name,
        color=payload.color,
        values=payload.values,
        description=payload.description,
        material_types=_validated_material_types(session, payload.material_types),
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
    if "material_types" in changes:
        changes["material_types"] = _validated_material_types(session, changes["material_types"])
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


def _template_matches(template: TagTemplate, dataset_types: list[str]) -> bool:
    """标签关联的素材类型与数据源素材类型有交集才同步;未关联任何类型的标签不同步。"""
    linked = template.material_types or []
    return bool(linked) and bool(set(linked) & set(dataset_types))


def sync_to_dataset(session: Session, source_dataset_id: str) -> list[TagTemplateOut]:
    """把标签库同步到某数据源:只同步与数据源素材类型匹配的标签(含枚举值)。

    同时清掉数据源里已不匹配、且未被任何图片使用的标签,让打标界面只看到本类型相关的标签;
    已被使用的标签保留,避免破坏既有图片标注。
    """
    from app.core.models import SourceDataset, SourceImageTag

    dataset = session.get(SourceDataset, source_dataset_id)
    if dataset is None:
        raise NotFoundError("source_dataset_not_found", "数据源不存在。")
    dataset_types = list(dataset.material_types or [])
    all_templates = list(session.scalars(select(TagTemplate).order_by(TagTemplate.name)))
    templates = [item for item in all_templates if _template_matches(item, dataset_types)]
    existing = {tag.name: tag for tag in session.scalars(select(SourceTag).where(SourceTag.source_dataset_id == source_dataset_id))}
    matched_names = {template.name for template in templates}
    for template in templates:
        found = existing.get(template.name)
        if found is None:
            session.add(SourceTag(id=new_id("stag"), source_dataset_id=source_dataset_id, name=template.name, color=template.color, values=template.values))
        else:
            found.color = template.color
            found.values = template.values
    # 清理:已不匹配且零使用的标签(被使用的保留)
    used_tag_ids = {row[0] for row in session.execute(select(SourceImageTag.tag_id).distinct())}
    for name, tag in existing.items():
        if name in matched_names or tag.id in used_tag_ids:
            continue
        session.delete(tag)
    session.commit()
    return [TagTemplateOut.model_validate(item) for item in templates]
