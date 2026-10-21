from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


SamFallbackMode = Literal["box", "disabled"]
LLMAuthScheme = Literal["bearer", "header", "raw_authorization"]


class SamSettingsResponse(BaseModel):
    enabled: bool
    backend: str = ""
    model: str
    device: str
    img_size: int
    fallback_mode: SamFallbackMode
    model_configured: bool


class SamSettingsUpdate(BaseModel):
    enabled: bool = True
    backend: str = Field(default="", max_length=512)
    model: str = Field(default="", max_length=1024)
    device: str = Field(default="auto", min_length=1, max_length=64)
    img_size: int = Field(default=1024, ge=64, le=4096)
    fallback_mode: SamFallbackMode = "box"


# Adapted from upstream YoloWebAgent settings/schemas.py (Community subset).
class LLMSettingsOut(BaseModel):
    enabled: bool = False
    provider: str = "openai-compatible"
    api_base: str = ""
    model: str = "gpt-4o-mini"
    temperature: float = 0.2
    timeout_seconds: int = 60
    api_key_configured: bool = False
    auth_scheme: LLMAuthScheme = "bearer"
    auth_header_name: str = ""


class LLMSettingsUpdate(BaseModel):
    enabled: bool = False
    provider: str = "openai-compatible"
    api_base: str = ""
    api_key: str | None = Field(default=None, description="Leave empty to keep the existing key.")
    model: str = "gpt-4o-mini"
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    timeout_seconds: int = Field(default=60, ge=1, le=7200)
    auth_scheme: LLMAuthScheme = "bearer"
    auth_header_name: str = ""


class LLMConnectionTestRequest(BaseModel):
    """Test connectivity without persisting settings (upstream pattern)."""

    api_base: str = ""
    model: str = "gpt-4o-mini"
    api_key: str | None = Field(default=None, description="Optional; empty uses saved key.")
    timeout_seconds: int = Field(default=60, ge=1, le=7200)
    auth_scheme: LLMAuthScheme = "bearer"
    auth_header_name: str = ""


class LLMConnectionTestResult(BaseModel):
    ok: bool
    message: str
    remote_test_performed: bool = False
    # Stable machine code for UI localization (message remains Chinese for logs/compat).
    code: str = "ok"
    http_status: int | None = None


class LLMSettingsInternal(LLMSettingsOut):
    api_key: str = ""


class FtpSettingsOut(BaseModel):
    host: str = ""
    port: int = 21
    username: str = ""
    password_configured: bool = False
    passive: bool = True
    encoding: str = "utf-8"
    timeout_seconds: int = 15


class FtpSettingsUpdate(BaseModel):
    host: str = Field(default="", max_length=255)
    port: int = Field(default=21, ge=1, le=65535)
    username: str = Field(default="", max_length=128)
    password: str | None = Field(default=None, description="Leave empty to keep the existing password.")
    passive: bool = True
    encoding: str = Field(default="utf-8", max_length=32)
    timeout_seconds: int = Field(default=15, ge=3, le=120)


class FtpSettingsInternal(FtpSettingsOut):
    password: str = ""


class FtpConnectionTestResult(BaseModel):
    ok: bool
    message: str
    code: str = "ok"


# --- Training nodes (remote compute agents) ---


class TrainingNodeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=512)
    token: str = Field(default="", max_length=512)
    enabled: bool = True

    @field_validator("name", "url", "token")
    @classmethod
    def strip_fields(cls, value: str) -> str:
        return value.strip()


class TrainingNodeOut(BaseModel):
    id: str
    name: str
    url: str
    token_configured: bool
    enabled: bool


class TrainingNodeTestRequest(BaseModel):
    url: str = Field(min_length=1, max_length=512)
    token: str = Field(default="", max_length=512)

    @field_validator("url", "token")
    @classmethod
    def strip_fields(cls, value: str) -> str:
        return value.strip()


class TrainingNodeTestResult(BaseModel):
    ok: bool
    message: str
    hostname: str | None = None
    device_count: int = 0
    device_types: list[str] = Field(default_factory=list)


# --- Webhook (training lifecycle notifications) ---


WebhookMethod = Literal["GET", "POST"]
WebhookEvent = Literal["started", "completed", "failed", "stopped"]

WEBHOOK_EVENTS: tuple[WebhookEvent, ...] = ("started", "completed", "failed", "stopped")


class WebhookSettingsOut(BaseModel):
    enabled: bool = False
    url: str = ""
    method: WebhookMethod = "POST"
    events: list[WebhookEvent] = Field(default_factory=lambda: list(WEBHOOK_EVENTS))
    body_template: str = ""


class WebhookSettingsUpdate(BaseModel):
    enabled: bool = False
    url: str = Field(default="", max_length=2048)
    method: WebhookMethod = "POST"
    events: list[WebhookEvent] = Field(default_factory=lambda: list(WEBHOOK_EVENTS))
    body_template: str = Field(default="", max_length=4096)

    @field_validator("url", "body_template")
    @classmethod
    def strip_url(cls, value: str) -> str:
        return value.strip()


class WebhookDeliveryResult(BaseModel):
    ok: bool
    message: str
    code: str = "ok"
    http_status: int | None = None
