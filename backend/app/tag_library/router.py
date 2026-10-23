from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_session
from app.tag_library.schemas import TagTemplateCreate, TagTemplateOut, TagTemplateUpdate
from app.tag_library.service import (
    create_template,
    delete_template,
    list_templates,
    sync_to_dataset,
    update_template,
)

router = APIRouter(prefix="/tag-templates", tags=["tag-library"])


@router.get("", response_model=list[TagTemplateOut])
def list_all(session: Session = Depends(get_session)) -> list[TagTemplateOut]:
    return list_templates(session)


@router.post("", response_model=TagTemplateOut, status_code=201)
def create(payload: TagTemplateCreate, session: Session = Depends(get_session)) -> TagTemplateOut:
    return create_template(session, payload)


@router.patch("/{template_id}", response_model=TagTemplateOut)
def update(template_id: str, payload: TagTemplateUpdate, session: Session = Depends(get_session)) -> TagTemplateOut:
    return update_template(session, template_id, payload)


@router.delete("/{template_id}", status_code=204, response_class=Response, response_model=None)
def remove(template_id: str, session: Session = Depends(get_session)) -> None:
    delete_template(session, template_id)


@router.post("/sync/{source_dataset_id}", response_model=list[TagTemplateOut])
def sync(source_dataset_id: str, session: Session = Depends(get_session)) -> list[TagTemplateOut]:
    return sync_to_dataset(session, source_dataset_id)
