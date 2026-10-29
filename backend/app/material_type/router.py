from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_session
from app.material_type.schemas import MaterialTypeCreate, MaterialTypeOut, MaterialTypeUpdate
from app.material_type.service import create_type, delete_type, list_types, update_type

router = APIRouter(prefix="/material-types", tags=["material-type"])


@router.get("", response_model=list[MaterialTypeOut])
def list_all(session: Session = Depends(get_session)) -> list[MaterialTypeOut]:
    return list_types(session)


@router.post("", response_model=MaterialTypeOut, status_code=201)
def create(payload: MaterialTypeCreate, session: Session = Depends(get_session)) -> MaterialTypeOut:
    return create_type(session, payload.name, payload.description)


@router.patch("/{type_id}", response_model=MaterialTypeOut)
def update(type_id: str, payload: MaterialTypeUpdate, session: Session = Depends(get_session)) -> MaterialTypeOut:
    return update_type(session, type_id, payload.name, payload.description)


@router.delete("/{type_id}", status_code=204, response_class=Response, response_model=None)
def remove(type_id: str, session: Session = Depends(get_session)) -> None:
    delete_type(session, type_id)
