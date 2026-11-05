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
    # OM 转换节点测试时附带：agent 所在环境是否有 atc 命令
    convert_supported: bool | None = None


# --- Webhook (training lifecycle notifications) ---


WebhookMethod = Literal["GET", "POST"]
WebhookEvent = Literal["started", "completed", "failed", "stopped"]

WEBHOOK_EVENTS: tuple[WebhookEvent, ...] = ("started", "completed", "failed", "stopped")
# 默认订阅的核心事件:启动 / 完成 / 异常(stopped 仍可手动勾选)。
DEFAULT_WEBHOOK_EVENTS: tuple[WebhookEvent, ...] = ("started", "completed", "failed")

# 每个事件预置的完整请求体模板(企业微信文本消息格式);留空即使用对应预置。
DEFAULT_EVENT_TEMPLATES: dict[str, str] = {
    'started': '{"msgtype":"text","text":{"content":"🚀 训练启动：{task_name}\\n数据集：{dataset}（{dataset_version}）\\n模型：{model}\\n任务ID：{task_id}"}}',
    'completed': '{"msgtype":"text","text":{"content":"✅ 训练完成：{task_name}\\n数据集：{dataset}（{dataset_version}）\\n模型：{model}\\n指标：{metrics}\\n耗时：{duration}\\n任务ID：{task_id}"}}',
    'failed': '{"msgtype":"text","text":{"content":"❌ 训练异常：{task_name}\\n数据集：{dataset}（{dataset_version}）\\n模型：{model}\\n耗时：{duration}\\n错误：{error_message}\\n任务ID：{task_id}"}}',
    'stopped': '{"msgtype":"text","text":{"content":"⏹️ 训练已停止：{task_name}\\n数据集：{dataset}（{dataset_version}）\\n耗时：{duration}\\n任务ID：{task_id}"}}',
}


class WebhookSettingsOut(BaseModel):
    enabled: bool = False
    url: str = ""
    method: WebhookMethod = "POST"
    events: list[WebhookEvent] = Field(default_factory=lambda: list(DEFAULT_WEBHOOK_EVENTS))
    body_templates: dict[WebhookEvent, str] = Field(default_factory=dict)


class WebhookSettingsUpdate(BaseModel):
    enabled: bool = False
    url: str = Field(default="", max_length=2048)
    method: WebhookMethod = "POST"
    events: list[WebhookEvent] = Field(default_factory=lambda: list(DEFAULT_WEBHOOK_EVENTS))
    body_templates: dict[str, str] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def strip_url(cls, value: str) -> str:
        return value.strip()

    @field_validator("body_templates")
    @classmethod
    def normalise_templates(cls, value: dict[str, str]) -> dict[str, str]:
        return {
            event: str(value.get(event, "") or "").strip()[:4096]
            for event in WEBHOOK_EVENTS
        }


class WebhookDeliveryResult(BaseModel):
    ok: bool
    message: str
    code: str = "ok"
    http_status: int | None = None
