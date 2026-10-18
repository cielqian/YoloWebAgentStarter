from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_session, get_settings
from app.class_library.schemas import ClassTemplateCreate, ClassTemplateResponse, ClassTemplateUpdate
from app.class_library.service import (
    create_template,
    delete_template,
    list_templates,
    update_template,
)
from app.class_library.translation import resolve_sam3_prompt
from app.core.config import Settings

router = APIRouter(prefix="/class-templates", tags=["class-templates"])


class TranslateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class TranslateResponse(BaseModel):
    sam3_prompt: str | None
    source: str


@router.get("", response_model=list[ClassTemplateResponse])
def get_templates(session: Session = Depends(get_session)) -> list[ClassTemplateResponse]:
    return [ClassTemplateResponse.model_validate(item) for item in list_templates(session)]


@router.post("", response_model=ClassTemplateResponse, status_code=201)
def post_template(
    payload: ClassTemplateCreate,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClassTemplateResponse:
    return ClassTemplateResponse.model_validate(create_template(session, payload, settings))


@router.patch("/{template_id}", response_model=ClassTemplateResponse)
def patch_template(
    template_id: str,
    payload: ClassTemplateUpdate,
    session: Session = Depends(get_session),
) -> ClassTemplateResponse:
    return ClassTemplateResponse.model_validate(update_template(session, template_id, payload))


@router.delete("/{template_id}", status_code=204, response_class=Response, response_model=None)
def remove_template(template_id: str, session: Session = Depends(get_session)) -> None:
    delete_template(session, template_id)


@router.post("/translate", response_model=TranslateResponse)
def translate(
    payload: TranslateRequest,
    settings: Settings = Depends(get_settings),
) -> TranslateResponse:
    prompt, source = resolve_sam3_prompt(settings, payload.name)
    return TranslateResponse(sam3_prompt=prompt, source=source)
