from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_settings
from app.core.config import Settings
from app.settings.schemas import (
    LLMConnectionTestRequest,
    LLMConnectionTestResult,
    LLMSettingsOut,
    LLMSettingsUpdate,
    SamSettingsResponse,
    SamSettingsUpdate,
    WebhookDeliveryResult,
    WebhookSettingsOut,
    WebhookSettingsUpdate,
)
from app.settings.service import SettingsService
from app.training.webhooks import TrainingWebhookNotifier


router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/sam", response_model=SamSettingsResponse)
def get_sam_settings(settings: Settings = Depends(get_settings)) -> SamSettingsResponse:
    return SettingsService(settings).get_sam()


@router.put("/sam", response_model=SamSettingsResponse)
def update_sam_settings(payload: SamSettingsUpdate, settings: Settings = Depends(get_settings)) -> SamSettingsResponse:
    return SettingsService(settings).update_sam(payload)


@router.get("/llm", response_model=LLMSettingsOut)
def get_llm_settings(settings: Settings = Depends(get_settings)) -> LLMSettingsOut:
    return SettingsService(settings).get_llm_settings()


@router.put("/llm", response_model=LLMSettingsOut)
def update_llm_settings(payload: LLMSettingsUpdate, settings: Settings = Depends(get_settings)) -> LLMSettingsOut:
    return SettingsService(settings).update_llm_settings(payload)


@router.post("/llm/test", response_model=LLMConnectionTestResult)
def test_llm_connection(
    payload: LLMConnectionTestRequest,
    settings: Settings = Depends(get_settings),
) -> LLMConnectionTestResult:
    return SettingsService(settings).test_llm_connection(payload)


@router.get("/webhook", response_model=WebhookSettingsOut)
def get_webhook_settings(settings: Settings = Depends(get_settings)) -> WebhookSettingsOut:
    return SettingsService(settings).get_webhook_settings()


@router.put("/webhook", response_model=WebhookSettingsOut)
def update_webhook_settings(payload: WebhookSettingsUpdate, settings: Settings = Depends(get_settings)) -> WebhookSettingsOut:
    return SettingsService(settings).update_webhook_settings(payload)


@router.post("/webhook/test", response_model=WebhookDeliveryResult)
def test_webhook(settings: Settings = Depends(get_settings)) -> WebhookDeliveryResult:
    return TrainingWebhookNotifier(settings).test()
