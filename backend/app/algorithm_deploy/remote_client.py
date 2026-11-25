"""compute-agent 远程算法服务节点的 HTTP 客户端(与 remote_training/om_convert 同一约定)。

自 algorithm_deploy pycache 反编译恢复(2026-11-25),对接 agent 侧 /services 端点:
create → upload_workspace → start,状态/日志/启停/删除。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from app.core.errors import ValidationError

_UPLOAD_TIMEOUT = httpx.Timeout(600.0)
_POLL_TIMEOUT = httpx.Timeout(15.0)
_STOP_TIMEOUT = httpx.Timeout(120.0)


def _base(node: dict) -> str:
    return str(node.get("url", "")).rstrip("/")


def _headers(node: dict) -> dict:
    token = str(node.get("token", "") or "").strip()
    return {"X-Agent-Token": token} if token else {}


def _detail(response: httpx.Response) -> str | None:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return str(detail or response.text[:200])


def _call(node: dict, method: str, path: str, *, timeout: httpx.Timeout, json_body: Any = None, content: bytes | None = None, headers: dict | None = None) -> dict:
    url = f"{_base(node)}{path}"
    request_headers = {**_headers(node), **(headers or {})}
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.request(method, url, json=json_body, content=content, headers=request_headers)
    except httpx.HTTPError as exc:
        raise ValidationError(
            "algorithm_deploy_node_unreachable",
            f"算法服务节点不可达（{node.get('name') or node.get('url')}）：{exc.__class__.__name__}",
        ) from exc
    if response.status_code == 401:
        raise ValidationError("algorithm_deploy_node_unauthorized", "节点 token 校验失败（401），请检查共享密钥。")
    if response.status_code >= 400:
        raise ValidationError("algorithm_deploy_node_error", f"节点返回 HTTP {response.status_code}：{_detail(response)}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise ValidationError("algorithm_deploy_node_error", "节点响应不是合法 JSON。") from exc
    if not isinstance(payload, dict):
        raise ValidationError("algorithm_deploy_node_error", "节点响应格式不正确。")
    return payload


def create_service(node: dict, spec: dict) -> dict:
    return _call(node, "POST", "/services", timeout=_POLL_TIMEOUT, json_body=spec)


def upload_workspace(node: dict, service_id: str, archive: Path) -> dict:
    return _call(
        node,
        "PUT",
        f"/services/{service_id}/workspace",
        timeout=_UPLOAD_TIMEOUT,
        content=archive.read_bytes(),
        headers={"Content-Type": "application/zip"},
    )


def start_service(node: dict, service_id: str) -> dict:
    return _call(node, "POST", f"/services/{service_id}/start", timeout=_POLL_TIMEOUT)


def stop_service(node: dict, service_id: str) -> dict:
    return _call(node, "POST", f"/services/{service_id}/stop", timeout=_STOP_TIMEOUT)


def service_status(node: dict, service_id: str) -> dict:
    return _call(node, "GET", f"/services/{service_id}", timeout=_POLL_TIMEOUT)


def service_logs(node: dict, service_id: str, tail: int = 400) -> str:
    payload = _call(node, "GET", f"/services/{service_id}/logs?tail={max(1, min(int(tail), 400))}", timeout=_POLL_TIMEOUT)
    return str(payload.get("logs") or "")


def delete_service(node: dict, service_id: str) -> None:
    _call(node, "DELETE", f"/services/{service_id}", timeout=_STOP_TIMEOUT)
