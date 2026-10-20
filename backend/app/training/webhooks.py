from __future__ import annotations

import logging
import threading
from typing import Any

import httpx

from app.core.config import Settings
from app.core.models import TrainingTask
from app.core.time import utc_now
from app.settings.schemas import WebhookDeliveryResult, WebhookSettingsOut
from app.settings.service import SettingsService

logger = logging.getLogger("ywa")

WEBHOOK_TIMEOUT_SECONDS = 10.0

# TrainingTask.status → 通知事件；pending 不产生通知。
EVENT_BY_STATUS = {
    "running": "started",
    "completed": "completed",
    "failed": "failed",
    "stopped": "stopped",
}


def _iso(value: Any) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else None


def task_payload(task: TrainingTask) -> dict[str, Any]:
    """组装通知里的任务快照。调用方需持有打开的 session（task.dataset 走懒加载）。"""
    dataset = task.dataset
    return {
        "id": task.id,
        "name": task.name,
        "dataset_id": task.dataset_id,
        "dataset_name": dataset.name if dataset is not None else None,
        "task_type": task.task_type,
        "model_name": task.model_name,
        "epochs": task.epochs,
        "device": task.device,
        "node_id": task.node_id,
        "status": task.status,
        "error_message": task.error_message,
        "started_at": _iso(task.started_at),
        "finished_at": _iso(task.finished_at),
        "progress_epoch": task.progress_epoch,
        "progress_total_epochs": task.progress_total_epochs,
        "progress_percent": task.progress_percent,
        "metrics": dict(task.metrics_json or {}),
    }


def deliver_webhook(
    config: WebhookSettingsOut,
    event: str,
    payload: dict[str, Any],
    *,
    transport: httpx.BaseTransport | None = None,
) -> WebhookDeliveryResult:
    """同步发送一次通知；失败只体现在返回值里，绝不抛出。"""
    try:
        with httpx.Client(timeout=WEBHOOK_TIMEOUT_SECONDS, transport=transport) as client:
            if config.method == "GET":
                params = {
                    "event": event,
                    "task_id": payload.get("id"),
                    "name": payload.get("name"),
                    "model_name": payload.get("model_name"),
                    "status": payload.get("status"),
                    "error_message": payload.get("error_message"),
                    "progress_percent": payload.get("progress_percent"),
                }
                response = client.get(
                    config.url,
                    params={key: str(value) for key, value in params.items() if value not in (None, "")},
                )
            else:
                body = {
                    "source": "YoloWebAgentStarter",
                    "event": event,
                    "occurred_at": _iso(utc_now()),
                    "task": payload,
                }
                response = client.post(config.url, json=body)
    except httpx.TimeoutException:
        return WebhookDeliveryResult(
            ok=False, message=f"Webhook 请求超时（{WEBHOOK_TIMEOUT_SECONDS:.0f} 秒）。", code="timeout"
        )
    except httpx.HTTPError as exc:
        return WebhookDeliveryResult(ok=False, message=f"Webhook 请求失败：{exc.__class__.__name__}", code="connect_error")
    if response.is_success:
        return WebhookDeliveryResult(
            ok=True, message=f"Webhook 通知已送达（HTTP {response.status_code}）。", code="ok", http_status=response.status_code
        )
    return WebhookDeliveryResult(
        ok=False, message=f"Webhook 目标返回 HTTP {response.status_code}。", code="http_error", http_status=response.status_code
    )


class TrainingWebhookNotifier:
    """训练生命周期事件的 fire-and-forget HTTP 通知。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def config(self) -> WebhookSettingsOut | None:
        try:
            value = SettingsService(self.settings).get_webhook_settings()
        except Exception:  # noqa: BLE001 - settings.json 损坏时退化为不通知
            logger.exception("读取 Webhook 设置失败，跳过通知。")
            return None
        if not value.enabled or not value.url:
            return None
        return value

    def prepare(self, event: str, task: TrainingTask) -> tuple[WebhookSettingsOut, dict[str, Any]] | None:
        config = self.config()
        if config is None or event not in config.events:
            return None
        return config, task_payload(task)

    def notify(self, event: str, task: TrainingTask) -> None:
        prepared = self.prepare(event, task)
        if prepared is None:
            return
        config, payload = prepared

        def run() -> None:
            result = deliver_webhook(config, event, payload)
            logger.log(logging.INFO if result.ok else logging.WARNING, "Webhook %s → %s: %s", event, config.url, result.message)

        threading.Thread(target=run, daemon=True, name=f"training-webhook-{event}").start()

    def test(self) -> WebhookDeliveryResult:
        config = self.config()
        if config is None:
            return WebhookDeliveryResult(ok=False, message="Webhook 未启用或未配置通知地址。", code="disabled")
        return deliver_webhook(config, "test", {"id": "webhook-test", "name": "Webhook 测试", "status": "test"})


_notifier: TrainingWebhookNotifier | None = None


def configure_webhooks(settings: Settings) -> None:
    """进程级初始化，在应用 lifespan 里调用一次。"""
    global _notifier
    _notifier = TrainingWebhookNotifier(settings)


def notify_training_event(event: str, task: TrainingTask) -> None:
    if _notifier is None:
        return
    try:
        _notifier.notify(event, task)
    except Exception:  # noqa: BLE001 - 通知异常绝不能影响训练状态流转
        logger.exception("发送训练 Webhook 通知失败。")


def notify_training_status(status: str, task: TrainingTask) -> None:
    """按任务当前状态触发对应事件；pending 等其它状态不通知。"""
    event = EVENT_BY_STATUS.get(status)
    if event is not None:
        notify_training_event(event, task)
