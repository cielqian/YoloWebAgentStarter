from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.models import Dataset, TrainingTask
from app.main import create_app
from app.settings.schemas import WebhookSettingsOut, WebhookSettingsUpdate
from app.settings.service import SettingsService
from app.training import webhooks
from app.training.webhooks import TrainingWebhookNotifier, deliver_webhook


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(
        project_root=Path(__file__).resolve().parents[2],
        data_dir=tmp_path / "data",
        import_root=tmp_path / "imports",
        database_url=f"sqlite:///{tmp_path / 'starter.db'}",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def make_task() -> TrainingTask:
    task = TrainingTask(
        id="train-1",
        dataset_id="ds-1",
        name="叶片检测训练",
        status="failed",
        task_type="detect",
        model_name="yolo11n",
        model_path="yolo11n.pt",
        epochs=50,
        img_size=640,
        batch_size=16,
        device="0",
        error_message="YOLO training exited with code 1.",
        progress_epoch=12,
        progress_total_epochs=50,
        progress_percent=24.0,
        metrics_json={"mAP50": 0.42},
    )
    task.dataset = Dataset(id="ds-1", name="叶片数据集", description=None, task_type="detect")
    return task


def test_webhook_settings_roundtrip(client: TestClient):
    default = client.get("/api/settings/webhook").json()
    assert default == {"enabled": False, "url": "", "method": "POST", "events": ["started", "completed", "failed", "stopped"]}

    updated = client.put(
        "/api/settings/webhook",
        json={"enabled": True, "url": "http://127.0.0.1:9000/hook ", "method": "GET", "events": ["failed", "started"]},
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body == {"enabled": True, "url": "http://127.0.0.1:9000/hook", "method": "GET", "events": ["started", "failed"]}

    assert client.get("/api/settings/webhook").json() == body


def test_webhook_settings_validation(client: TestClient):
    bad_scheme = client.put("/api/settings/webhook", json={"url": "ftp://example.com/hook"})
    assert bad_scheme.status_code == 422

    enabled_without_url = client.put("/api/settings/webhook", json={"enabled": True, "url": ""})
    assert enabled_without_url.status_code == 422


def test_webhook_test_endpoint(client: TestClient, monkeypatch):
    not_configured = client.post("/api/settings/webhook/test").json()
    assert not_configured["ok"] is False
    assert not_configured["code"] == "disabled"

    client.put("/api/settings/webhook", json={"enabled": True, "url": "http://hook.test/notify", "method": "POST"})
    delivered: list[tuple[WebhookSettingsOut, str, dict]] = []

    def fake_deliver(config, event, payload, **kwargs):
        delivered.append((config, event, payload))
        return webhooks.WebhookDeliveryResult(ok=True, message="送达", code="ok", http_status=200)

    monkeypatch.setattr(webhooks, "deliver_webhook", fake_deliver)
    result = client.post("/api/settings/webhook/test").json()
    assert result["ok"] is True
    assert delivered[0][1] == "test"


def test_deliver_webhook_post_sends_json_body():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(204)

    config = WebhookSettingsOut(enabled=True, url="http://hook.test/notify", method="POST")
    result = deliver_webhook(config, "failed", {"id": "train-1", "name": "叶片检测训练", "status": "failed"}, transport=httpx.MockTransport(handler))

    assert result.ok is True
    assert result.code == "ok"
    assert captured["method"] == "POST"
    assert captured["url"] == "http://hook.test/notify"
    assert captured["body"]["event"] == "failed"
    assert captured["body"]["task"]["id"] == "train-1"
    assert captured["body"]["occurred_at"]


def test_deliver_webhook_get_sends_query_params():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["params"] = dict(request.url.params)
        return httpx.Response(200)

    config = WebhookSettingsOut(enabled=True, url="http://hook.test/notify", method="GET")
    result = deliver_webhook(
        config, "started", {"id": "train-1", "name": "叶片检测训练", "model_name": "yolo11n", "status": "running", "error_message": None},
        transport=httpx.MockTransport(handler),
    )

    assert result.ok is True
    assert captured["method"] == "GET"
    assert captured["params"]["event"] == "started"
    assert captured["params"]["task_id"] == "train-1"
    assert "error_message" not in captured["params"]


def test_deliver_webhook_reports_failures():
    config = WebhookSettingsOut(enabled=True, url="http://hook.test/notify", method="POST")

    http_error = deliver_webhook(config, "failed", {}, transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    assert http_error.ok is False
    assert http_error.code == "http_error"
    assert http_error.http_status == 500

    def raise_timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    timeout = deliver_webhook(config, "failed", {}, transport=httpx.MockTransport(raise_timeout))
    assert timeout.ok is False
    assert timeout.code == "timeout"


def test_notifier_gates_on_config_and_events(tmp_path: Path):
    settings = Settings(
        project_root=Path(__file__).resolve().parents[2],
        data_dir=tmp_path / "data",
        import_root=tmp_path / "imports",
        database_url=f"sqlite:///{tmp_path / 'starter.db'}",
    )
    notifier = TrainingWebhookNotifier(settings)

    assert notifier.config() is None
    assert notifier.prepare("failed", make_task()) is None

    SettingsService(settings).update_webhook_settings(WebhookSettingsUpdate(enabled=True, url="http://hook.test/notify", events=["failed"]))
    assert notifier.prepare("started", make_task()) is None

    prepared = notifier.prepare("failed", make_task())
    assert prepared is not None
    _, payload = prepared
    assert payload["id"] == "train-1"
    assert payload["dataset_name"] == "叶片数据集"
    assert payload["status"] == "failed"
    assert payload["metrics"] == {"mAP50": 0.42}