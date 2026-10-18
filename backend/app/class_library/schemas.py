from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.schemas import ClassLabelResponse, ORMModel


class ClassTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(default="#22c55e", pattern=r"^#[0-9a-fA-F]{6}$")
    sam3_prompt: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("class name cannot be blank")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("class name cannot contain path separators")
        return cleaned


class ClassTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    sam3_prompt: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("class name cannot be blank")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("class name cannot contain path separators")
        return cleaned


class ClassTemplateResponse(ORMModel):
    id: str
    name: str
    color: str
    sam3_prompt: str | None
    created_at: datetime
    updated_at: datetime


class ClassImportRequest(BaseModel):
    template_ids: list[str] = Field(min_length=1, max_length=200)


class ClassImportResponse(BaseModel):
    imported: list[ClassLabelResponse]
    skipped_names: list[str]


class ClassLabelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    sam3_prompt: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("class name cannot be blank")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("class name cannot contain path separators")
        return cleaned
