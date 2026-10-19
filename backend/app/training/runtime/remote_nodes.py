"""Client for remote compute agents (compute-agent/ deployed on GPU/NPU servers).

Snapshots are cached briefly so listing devices stays fast when a node is
healthy, while unreachable nodes fail fast with RemoteNodeUnavailable.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

DEFAULT_TIMEOUT_SECONDS = 3.0
_CACHE_TTL_SECONDS = 15.0
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class RemoteNodeUnavailable(Exception):
    """The agent is unreachable, unauthorized, or returned a malformed body."""


def fetch_node_snapshot(url: str, token: str, timeout: float = DEFAULT_TIMEOUT_SECONDS, use_cache: bool = True) -> dict[str, Any]:
    base = url.strip().rstrip("/")
    key = f"{base}|{token.strip()}"
    now = time.monotonic()
    cached = _cache.get(key)
    if use_cache and cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    headers = {"X-Agent-Token": token.strip()} if token.strip() else {}
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(f"{base}/devices", headers=headers)
    except httpx.HTTPError as exc:
        raise RemoteNodeUnavailable(f"连接失败：{exc.__class__.__name__}") from exc
    if response.status_code == 401:
        raise RemoteNodeUnavailable("token 校验失败（401），请检查共享密钥。")
    if response.status_code != 200:
        raise RemoteNodeUnavailable(f"agent 返回 HTTP {response.status_code}。")
    try:
        payload = response.json()
        devices = payload["devices"]
        if not isinstance(devices, list):
            raise TypeError("devices is not a list")
    except (ValueError, KeyError, TypeError) as exc:
        raise RemoteNodeUnavailable("agent 响应格式不正确，请确认部署的是 compute-agent。") from exc
    snapshot = {"payload": payload, "fetched_at": time.time()}
    _cache[key] = (now, snapshot)
    return snapshot


def probe_node(url: str, token: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """One-shot connectivity check used by 设置-训练节点 and node listing."""

    try:
        snapshot = fetch_node_snapshot(url, token, timeout=timeout, use_cache=False)
    except RemoteNodeUnavailable as exc:
        return {"ok": False, "message": str(exc), "hostname": None, "device_count": 0, "device_types": []}
    payload = snapshot["payload"]
    devices = payload.get("devices", [])
    types = sorted({str(item.get("type")) for item in devices if isinstance(item, dict)})
    return {
        "ok": True,
        "message": "连接成功",
        "hostname": payload.get("hostname"),
        "device_count": len(devices),
        "device_types": types,
    }


def clear_cache() -> None:
    _cache.clear()


def merged_devices(settings: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Local devices plus remote-node devices, with per-node online status."""

    from app.settings.service import SettingsService
    from app.training.runtime.device_service import DeviceService

    items: list[dict[str, Any]] = [device.as_dict() for device in DeviceService().list_devices()]
    node_status: list[dict[str, Any]] = []
    for node in SettingsService(settings).list_training_nodes():
        if not node.get("enabled", True):
            continue
        url = str(node.get("url", ""))
        try:
            snapshot = fetch_node_snapshot(url, str(node.get("token", "")))
        except RemoteNodeUnavailable as exc:
            node_status.append(
                {
                    "id": node.get("id", ""),
                    "name": node.get("name", ""),
                    "url": url,
                    "enabled": True,
                    "status": "offline",
                    "device_count": 0,
                    "error": str(exc),
                }
            )
            continue
        devices = snapshot["payload"].get("devices", [])
        for device in devices:
            if not isinstance(device, dict):
                continue
            items.append(
                {
                    "id": f"{node.get('id', 'node')}:{device.get('id', '?')}",
                    "type": device.get("type", "cpu"),
                    "name": device.get("name", ""),
                    "index": device.get("index"),
                    "memory_total_mb": device.get("memory_total_mb"),
                    "memory_free_mb": device.get("memory_free_mb"),
                    "status": device.get("status") or "unknown",
                    "node_id": node.get("id"),
                    "node_name": node.get("name"),
                }
            )
        node_status.append(
            {
                "id": node.get("id", ""),
                "name": node.get("name", ""),
                "url": url,
                "enabled": True,
                "status": "online",
                "device_count": len(devices),
                "error": None,
            }
        )
    return items, node_status
