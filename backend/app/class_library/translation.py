from __future__ import annotations

import logging
import re

import httpx

from app.agent.llm_auth import build_llm_request_headers
from app.core.config import Settings

logger = logging.getLogger("ywa.class_library")

# 离线词典兜底：LLM 未配置或不可达时覆盖常见通用/工业检测概念
_BUILTIN_ZH_EN: dict[str, str] = {
    "人": "person", "行人": "pedestrian", "工人": "worker", "脸": "face", "手": "hand",
    "车": "car", "汽车": "car", "轿车": "sedan", "卡车": "truck", "货车": "truck",
    "公交车": "bus", "自行车": "bicycle", "摩托车": "motorcycle", "电动车": "electric scooter",
    "飞机": "airplane", "船": "boat", "火车": "train", "无人机": "drone",
    "屏幕": "screen", "显示器": "monitor", "手机": "mobile phone", "电脑": "computer",
    "键盘": "keyboard", "鼠标": "mouse", "电视": "tv", "摄像头": "camera", "路由器": "router",
    "狗": "dog", "猫": "cat", "鸟": "bird", "牛": "cattle", "羊": "sheep", "马": "horse",
    "猪": "pig", "鸡": "chicken", "鱼": "fish",
    "缺陷": "defect", "划痕": "scratch", "裂纹": "crack", "裂缝": "crack", "凹坑": "dent",
    "凹陷": "dent", "凸起": "bump", "气泡": "bubble", "污点": "stain", "脏污": "stain",
    "锈蚀": "rust", "锈斑": "rust", "异物": "foreign object", "毛刺": "burr", "破损": "damage",
    "断裂": "breakage", "漏装": "missing part", "错装": "wrong part", "变形": "deformation",
    "焊点": "solder joint", "虚焊": "cold solder joint", "短路": "short circuit", "断路": "open circuit",
    "字符": "character", "文字": "text", "数字": "number", "字母": "letter", "单词": "word",
    "二维码": "qr code", "条形码": "barcode", "标签": "label", "logo": "logo",
    "瓶": "bottle", "瓶子": "bottle", "箱": "box", "盒子": "box", "袋子": "bag",
    "安全帽": "helmet", "口罩": "face mask", "手套": "glove", "反光衣": "reflective vest",
    "烟头": "cigarette", "火焰": "flame", "烟雾": "smoke", "积水": "puddle", "垃圾": "litter",
    "轮胎": "tire", "玻璃": "glass", "金属": "metal", "塑料": "plastic", "纸张": "paper",
    "纸箱": "carton", "托盘": "pallet", "叉车": "forklift", "货架": "shelf", "包裹": "package",
    "硬币": "coin", "钥匙": "key", "剪刀": "scissors", "螺丝": "screw", "螺母": "nut",
    "螺栓": "bolt", "弹簧": "spring", "齿轮": "gear", "轴承": "bearing", "阀门": "valve",
    "管道": "pipe", "电缆": "cable", "插头": "plug", "插座": "socket", "开关": "switch",
    "指示灯": "indicator light", "按钮": "button", "表盘": "dial", "仪表": "gauge",
    "板材": "plate", "钢卷": "steel coil", "铝锭": "aluminum ingot",
}

_HAS_CJK = re.compile(r"[一-鿿]")
_ENGLISH_WORD = re.compile(r"^[a-zA-Z][a-zA-Z0-9 _-]*$")


def contains_cjk(text: str) -> bool:
    return bool(_HAS_CJK.search(text or ""))


def _sanitize_prompt(text: str) -> str | None:
    cleaned = " ".join(text.split()).strip(" .。,，!！?？\"'`")
    if cleaned and _ENGLISH_WORD.match(cleaned) and len(cleaned) <= 100:
        return cleaned.lower()
    return None


def _translate_with_llm(settings: Settings, name: str) -> tuple[str | None, str]:
    # 与 Agent 运行时保持同一配置来源：设置页保存的 LLM 信息在 settings.json，
    # 而不是环境变量级 Settings.agent_*（默认 provider=mock，会让翻译永远走不通）。
    from app.agent.providers.mock import llm_is_usable
    from app.settings.service import SettingsService

    llm = SettingsService(settings).get_llm_settings_internal()
    if not llm_is_usable(llm):
        return None, "llm_unconfigured"
    headers = build_llm_request_headers(
        llm.api_key,
        llm.auth_scheme,
        llm.auth_header_name or "",
    )
    payload = {
        "model": llm.model,
        "messages": [
            {
                "role": "user",
                "content": (
                    f'把下面的中文类别名翻译成适合 SAM3 文本提示分割的英文名词短语'
                    f'（目标检测概念词，如 "缺陷"->defect、"划痕"->scratch）。'
                    f'只输出英文短语本身，不要任何解释或标点。\n类别名：{name}'
                ),
            }
        ],
        "temperature": 0.1,
        "max_tokens": 32,
    }
    try:
        with httpx.Client(timeout=min(float(llm.timeout_seconds or 8.0), 20.0), trust_env=False) as client:
            response = client.post(
                f"{(llm.api_base or '').rstrip('/')}/chat/completions",
                json=payload,
                headers=headers,
            )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        logger.info("SAM3 prompt LLM translation failed for %r: %s", name, exc)
        return None, "llm_failed"
    prompt = _sanitize_prompt(content or "")
    if prompt is None:
        return None, "llm_invalid"
    return prompt, "llm"


def resolve_sam3_prompt(settings: Settings, name: str) -> tuple[str | None, str]:
    """Resolve (prompt, source) where source explains how the prompt was derived."""
    name = (name or "").strip()
    if not name:
        return None, "empty"
    if not contains_cjk(name):
        return _sanitize_prompt(name), "english"
    if name in _BUILTIN_ZH_EN:
        return _BUILTIN_ZH_EN[name], "dictionary"
    return _translate_with_llm(settings, name)


def default_sam3_prompt(settings: Settings, name: str) -> str | None:
    """Derive the English SAM3 concept prompt for a class name.

    英文名直接复用；中文优先查内置词典，未命中再尝试已配置的 LLM，都失败返回 None。
    """
    return resolve_sam3_prompt(settings, name)[0]
