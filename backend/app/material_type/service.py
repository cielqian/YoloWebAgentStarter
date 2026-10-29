"""素材类型库:数据源多选属性的全局取值范围;改名/删除级联清理数据源引用。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError
from app.core.ids import new_id
from app.core.models import MaterialType, SourceDataset


def list_types(session: Session) -> list[MaterialType]:
    return list(session.scalars(select(MaterialType).order_by(MaterialType.created_at, MaterialType.id)))


def get_type(session: Session, type_id: str) -> MaterialType:
    item = session.get(MaterialType, type_id)
    if item is None:
        raise NotFoundError("material_type_not_found", "素材类型不存在。")
    return item


def _dataset_usage_count(session: Session, name: str) -> int:
    datasets = list(session.scalars(select(SourceDataset)))
    return sum(1 for dataset in datasets if name in (dataset.material_types or []))


def create_type(session: Session, name: str, description: str | None) -> MaterialType:
    existing = session.scalar(select(MaterialType).where(MaterialType.name == name))
    if existing is not None:
        raise ConflictError("material_type_exists", f"素材类型“{name}”已存在。")
    item = MaterialType(id=new_id("mt"), name=name, description=description)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def update_type(session: Session, type_id: str, name: str | None, description: str | None) -> MaterialType:
    item = get_type(session, type_id)
    updates: dict[str, object] = {}
    if name is not None and name != item.name:
        existing = session.scalar(select(MaterialType).where(MaterialType.name == name))
        if existing is not None:
            raise ConflictError("material_type_exists", f"素材类型“{name}”已存在。")
        _rename_in_datasets(session, item.name, name)
        updates["name"] = name
    if description is not None:
        updates["description"] = description
    if updates:
        for field, value in updates.items():
            setattr(item, field, value)
        session.commit()
        session.refresh(item)
    return item


def delete_type(session: Session, type_id: str) -> None:
    item = get_type(session, type_id)
    for dataset in session.scalars(select(SourceDataset)):
        types = dataset.material_types or []
        if item.name in types:
            dataset.material_types = [entry for entry in types if entry != item.name] or None
    session.delete(item)
    session.commit()


def validate_names(session: Session, names: list[str]) -> list[str]:
    """数据源写入素材类型时的取值校验:必须全部存在于素材类型库。"""
    known = {item.name for item in list_types(session)}
    unknown = [name for name in names if name not in known]
    if unknown:
        raise ConflictError(
            "material_type_unknown",
            f"素材类型不存在:{'、'.join(unknown)}。请先在基础数据-素材类型中添加。",
        )
    return names


def _rename_in_datasets(session: Session, old_name: str, new_name: str) -> None:
    """类型改名时级联更新数据源上的引用,保证名称全局一致。"""
    for dataset in session.scalars(select(SourceDataset)):
        types = dataset.material_types or []
        if old_name in types:
            dataset.material_types = [new_name if entry == old_name else entry for entry in types]
