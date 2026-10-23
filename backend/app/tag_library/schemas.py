from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TagTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    color: str = Field(default="#3157d5", pattern=r"^#[0-9a-fA-F]{6}$")
    values: list[str] | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("tag name cannot be blank")
        return cleaned

    @field_validator("values")
    @classmethod
    def clean_values(cls, value: list[str] | None) -> list[str] | None:
        if not value:
            return None
        cleaned = [item.strip() for item in value if item.strip()]
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("tag values must be unique")
        return cleaned or None


class TagTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    values: list[str] | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("tag name cannot be blank")
        return cleaned

    @field_validator("values")
    @classmethod
    def clean_values(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned = [item.strip() for item in value if item.strip()]
        if len(cleaned) != len(set(cleaned)):
            raise ValueError("tag values must be unique")
        return cleaned or None


class TagTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    color: str
    values: list[str] | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime
