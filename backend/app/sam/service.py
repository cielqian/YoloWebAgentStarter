from __future__ import annotations

import math
import threading
from gc import collect
from pathlib import Path

import cv2
import httpx
import numpy as np
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import ValidationError
from app.core.ids import new_id
from app.core.models import ClassLabel, Dataset
from app.core.schemas import BBox
from app.core.storage import Storage
from app.dataset.annotation.geometry import validate_bbox, validate_polygon
from app.dataset.images import get_image
from app.sam.schemas import SamPredictRequest, SamPredictResponse
from app.settings.service import SamSettingsService


_MODEL_LOCK = threading.Lock()
_MODELS: dict[tuple[str, str], object] = {}


def _box_polygon(box: BBox) -> list[tuple[float, float]]:
    return [
        (box.x, box.y),
        (box.x + box.width, box.y),
        (box.x + box.width, box.y + box.height),
        (box.x, box.y + box.height),
    ]


def _valid_polygons(
    polygons: list[list[tuple[float, float]]],
    image_width: int,
    image_height: int,
) -> list[list[tuple[float, float]]]:
    valid: list[list[tuple[float, float]]] = []
    for polygon in polygons:
        try:
            validate_polygon(polygon, image_width, image_height)
        except ValidationError:
            continue
        valid.append(polygon)
    return valid


def clear_model_cache() -> None:
    """Release cached SAM models after a local SAM configuration change."""

    with _MODEL_LOCK:
        _MODELS.clear()
    collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except (ImportError, OSError, AttributeError, RuntimeError):
        pass


def _model_for(model_reference: str, device: str) -> object:
    key = (model_reference, device)
    with _MODEL_LOCK:
        model = _MODELS.get(key)
        if model is not None:
            return model
        # The application supports one interactive SAM configuration at a
        # time. Retaining past checkpoints here would keep their CPU/GPU
        # allocations alive after the user switches settings.
        _MODELS.clear()
        try:
            from ultralytics import SAM

            model = SAM(model_reference)
        except Exception as exc:
            raise ValidationError("sam_model_unavailable", f"SAM model could not be loaded: {exc}") from exc
        _MODELS[key] = model
        return model


def _predict_with_sam(
    image_path: Path,
    request: SamPredictRequest,
    model_reference: str,
    device: str,
    img_size: int,
) -> tuple[list[tuple[float, float]], float, str | None]:
    try:
        model = _model_for(model_reference, device)
    except TypeError as exc:
        # Keep the small helper easy to replace in tests and by local plugins
        # that still implement the original one-argument hook.
        try:
            model = _model_for(model_reference)  # type: ignore[call-arg]
        except TypeError:
            raise exc
    kwargs: dict[str, object] = {"source": str(image_path), "imgsz": img_size, "verbose": False}
    if device != "auto":
        kwargs["device"] = device
    if request.box is not None:
        kwargs["bboxes"] = [[request.box.x, request.box.y, request.box.x + request.box.width, request.box.y + request.box.height]]
    if request.points:
        kwargs["points"] = [[point.x, point.y] for point in request.points]
        kwargs["labels"] = [point.label for point in request.points]
    try:
        results = model.predict(**kwargs)  # type: ignore[attr-defined]
        if not results or getattr(results[0], "masks", None) is None or not results[0].masks.xy:
            raise ValueError("SAM returned no masks for this prompt")
        points = [(float(x), float(y)) for x, y in results[0].masks.xy[0].tolist()]
        score = 1.0
        boxes = getattr(results[0], "boxes", None)
        if boxes is not None and getattr(boxes, "conf", None) is not None and len(boxes.conf):
            score = float(boxes.conf[0].detach().cpu().item())
        # The prediction result is the authoritative source of the device.
        # In particular, reporting the configured value "auto" would be
        # misleading because Ultralytics selects a concrete device at runtime.
        for prediction_data in (getattr(results[0].masks, "data", None), getattr(boxes, "data", None)):
            device = getattr(prediction_data, "device", None)
            if device is not None:
                return points, score, str(device)
        return points, score, None
    except ValidationError:
        raise
    except Exception as exc:
        raise ValidationError("sam_prediction_failed", f"SAM prediction failed: {exc}") from exc



def _mask_polygons_from_result(original_path: Path, result_bytes: bytes) -> list[list[tuple[float, float]]]:
    """严格按 services/sam3/sam3_single_infer.py 的绘制方式反解掩码。

    demo 把所有实例掩码 OR 合并后 alpha_composite 到原图：红色 (255,0,0)
    alpha=110/255 半透明填充 + 1px 纯白不透明边界描边（描边在掩码内侧，
    boundary &= combined，需计回掩码）；黄框与左上文字为不透明纯色，不在掩码内。
    闭运算 7 愈合黄框切口（3px 线 + JPEG 扩散约 5-8px，更大核会把相邻实例粘连）。
    """
    original = cv2.imread(str(original_path))
    result = cv2.imdecode(np.frombuffer(result_bytes, np.uint8), cv2.IMREAD_COLOR)
    if original is None or result is None:
        raise ValidationError("sam_prediction_failed", "SAM3 结果图解析失败")
    if original.shape != result.shape:
        result = cv2.resize(result, (original.shape[1], original.shape[0]))
    source = original.astype(np.float32)
    overlay = result.astype(np.float32)
    red_alpha = 110.0 / 255.0
    pred_fill = (1.0 - red_alpha) * source + red_alpha * np.array([0.0, 0.0, 255.0], np.float32)
    fill_residual = np.abs(overlay - pred_fill).max(axis=2)
    changed = np.abs(overlay - source).max(axis=2)
    red = (fill_residual < 45) & (changed > 30)
    # 白描边：纯白且紧邻红填充（≤2px）才是掩码边界；左上角白色文字不与掩码紧邻，被该约束排除
    white_line = (np.abs(overlay - 255.0).max(axis=2) < 70) & (changed > 30)
    near_red = cv2.dilate(red.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    mask = (red | (white_line & near_red)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    num, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    clean = np.zeros_like(mask)
    for index in range(1, num):
        if stats[index, cv2.CC_STAT_AREA] >= 200:
            clean[labels == index] = 255
    contours, _ = cv2.findContours(clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polygons: list[list[tuple[float, float]]] = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:32]:
        if cv2.contourArea(contour) < 200:
            break
        # eps=0.5px 让折线贴近像素级掩码轮廓（远程 demo 是逐像素渲染，顶点太稀会显得粗糙）
        approx = cv2.approxPolyDP(contour, 0.5, True)
        poly = [(float(point[0][0]), float(point[0][1])) for point in approx]
        if len(poly) >= 3:
            polygons.append(poly)
    return polygons


def _predict_with_remote(
    base_url: str,
    image_path: Path,
    prompt_text: str,
    box: BBox | None = None,
) -> tuple[list[list[tuple[float, float]]], float, str | None]:
    """调用 services/sam3/api_server.py 的 POST /segment 并差分提取多边形。

    框选时把提示框一并传给服务端：服务端只对框内裁剪图推理，再把叠加
    结果贴回原图返回，因此返回图与原图同尺寸、同坐标系，可直接差分。
    """
    if not prompt_text.strip():
        raise ValidationError("sam_model_not_configured", "远程 SAM3 依赖类别名作为概念提示，请先为标注任务配置类别。")
    base = base_url.rstrip("/")
    form: dict[str, str] = {"prompt": prompt_text}
    if box is not None:
        x1 = int(round(box.x))
        y1 = int(round(box.y))
        x2 = int(round(box.x + box.width))
        y2 = int(round(box.y + box.height))
        form["box"] = f"{x1},{y1},{x2},{y2}"
    try:
        with httpx.Client(timeout=httpx.Timeout(330.0, connect=10.0), trust_env=False) as client:
            with image_path.open("rb") as handle:
                response = client.post(
                    f"{base}/segment",
                    data=form,
                    files={"image": (image_path.name, handle)},
                )
            if response.status_code != 200:
                detail = response.text[:200]
                try:
                    parsed = response.json()
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict) and parsed.get("detail"):
                    detail = str(parsed["detail"])[:200]
                raise ValidationError(
                    "sam_prediction_failed",
                    f"SAM3 服务返回 {response.status_code}: {detail}",
                )
            if "image" not in response.headers.get("content-type", ""):
                raise ValidationError("sam_prediction_failed", "SAM3 服务返回了非图片内容，无法提取多边形")
            result_bytes = response.content
            score = 1.0
            raw_score = response.headers.get("x-score", "").strip()
            if raw_score:
                try:
                    score = float(raw_score)
                except ValueError:
                    pass
    except httpx.HTTPError as exc:
        raise ValidationError("sam_model_unavailable", f"SAM3 服务连接失败: {exc}") from exc
    polygons = _mask_polygons_from_result(image_path, result_bytes)
    if not polygons:
        raise ValidationError("sam_prediction_failed", "SAM returned no masks for this prompt")
    return polygons, score, "remote"


class SamService:
    """Domain service for local SAM-assisted polygon proposals.

    The proposal is deliberately not persisted here. It is returned to the
    annotation editor for review, then saved through the normal annotation
    transaction with ``source='sam'``.
    """

    def __init__(self, storage: Storage, settings: Settings) -> None:
        self.storage = storage
        self.settings = settings

    def predict(self, session: Session, request: SamPredictRequest) -> SamPredictResponse:
        image = get_image(session, request.image_id)
        dataset = session.get(Dataset, image.dataset_id)
        if dataset is None or dataset.task_type != "segment":
            raise ValidationError("sam_requires_segment_dataset", "SAM proposals can only be saved as polygon annotations in segment datasets.")
        class_label = session.get(ClassLabel, request.class_id)
        if class_label is None or class_label.dataset_id != image.dataset_id:
            raise ValidationError("class_not_in_dataset", "SAM class does not belong to the image dataset.")
        if request.box is not None:
            validate_bbox(request.box, image.width, image.height)
        if any(
            not math.isfinite(point.x)
            or not math.isfinite(point.y)
            or point.x < 0
            or point.y < 0
            or point.x > image.width
            or point.y > image.height
            for point in request.points
        ):
            raise ValidationError("sam_point_out_of_bounds", "SAM prompt points must stay inside the image.")
        path = self.storage.image_path(image.dataset_id, image.storage_name)
        if not path.is_file():
            raise ValidationError("image_file_missing", "The managed image file is missing.")

        sam = SamSettingsService(self.settings).get()
        if not sam.enabled:
            raise ValidationError("sam_disabled", "SAM 辅助标注已在设置中关闭。")
        if sam.backend:
            # 远程 SAM3 的概念空间只覆盖英文；优先用类别的英文提示词，缺翻译时直接指出而不是白等一次推理
            from app.class_library.translation import contains_cjk

            prompt_text = (class_label.sam3_prompt or "").strip() or class_label.name
            if contains_cjk(prompt_text):
                raise ValidationError(
                    "sam3_prompt_not_english",
                    f"类别“{class_label.name}”缺少英文 SAM3 提示词，请在类别面板或类别管理中维护后重试。",
                )
            if request.box is not None:
                # 框选：提示框随请求传给服务端，服务端只对框内裁剪图推理，无需本地再过滤
                polygons, score, device = _predict_with_remote(sam.backend, path, prompt_text, box=request.box)
            else:
                # 点选：点击只是触发推理（服务端无点提示参数），全图推理并把该类别全部实例都返回
                polygons, score, device = _predict_with_remote(sam.backend, path, prompt_text)
            if not polygons:
                raise ValidationError("sam_prediction_failed", "SAM 未找到目标实例")
            backend_used = "remote-sam3"
        elif sam.model:
            polygon, score, device = _predict_with_sam(path, request, sam.model, sam.device, sam.img_size)
            polygons, backend_used = [polygon], "ultralytics_sam"
        elif request.box is not None and sam.fallback_mode == "box":
            polygons, score, device, backend_used = [_box_polygon(request.box)], 1.0, None, "box_stub"
        else:
            raise ValidationError(
                "sam_model_not_configured",
                "点提示需要在设置中配置本地或 Ultralytics SAM 权重。",
            )
        # 远程结果图可能带出多个实例，逐个校验并丢弃越界/过小的，而不是让整体失败。
        valid_polygons = _valid_polygons(polygons, image.width, image.height)
        if not valid_polygons:
            raise ValidationError("sam_prediction_failed", "SAM returned no valid polygons for this prompt")
        return SamPredictResponse(
            image_id=image.id,
            class_id=class_label.id,
            mask_id=new_id("mask"),
            polygons=valid_polygons,
            score=score,
            backend_used=backend_used,
            device=device,
        )
