"""算法服务部署包生成模板(自 algorithm_deploy pycache 反编译恢复,2026-11-25)。

把平台训练产出的 onnx/om 模型按 common_service_onnx 可加载的 pipeline 组装成部署目录:

    <deploy_dir>/common_service_onnx/     # 算法服务源码目录打包(去掉业务模型/数据/日志)
    <deploy_dir>/common_service_onnx/models/<tag>/pipeline.json
    <deploy_dir>/common_service_onnx/models/<tag>/<tag>_inferencer.py       # 通用 YOLO 推理器
    <deploy_dir>/common_service_onnx/models/<tag>/<tag>_response_builder.py # 通用响应构建器
    <deploy_dir>/common_service_onnx/models/<tag>/model.onnx|model.om
    <deploy_dir>/logs/                    # 容器内 /logs
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from app.core.errors import ValidationError

_TAG_SAFE = re.compile("[^a-z0-9_]+")
_SOURCE_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "*.log", "logs", "测试数据", "models", "data_file")


def sanitize_tag(stem: str) -> str:
    tag = _TAG_SAFE.sub("_", (stem or "model").strip().lower()).strip("_")
    return f"ywa_{tag}" if tag else "ywa_model"


def class_name_for(tag: str) -> str:
    return "".join(part.capitalize() for part in tag.split("_") if part)


def build_workspace(
    deploy_dir: Path,
    source_code_dir: Path,
    tag: str,
    model_src: Path,
    model_format: str,
    classes: list[str],
    conf_threshold: float,
    iou_threshold: float,
    sessions: int,
    img_size: int,
) -> Path:
    """组装部署工作区,返回 common_service_onnx 目录;同 tag 重复部署会整体重建。"""

    source = source_code_dir / "common_service_onnx"
    if not source.is_dir():
        raise ValidationError("algorithm_serving_code_missing", f"算法服务代码目录不存在: {source_code_dir}(需要包含 common_service_onnx/)")

    workspace = deploy_dir / "common_service_onnx"
    if workspace.exists():
        shutil.rmtree(workspace)
    shutil.copytree(source, workspace, ignore=_SOURCE_IGNORE)

    model_dir = workspace / "models" / tag
    model_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(model_src, model_dir / f"model.{model_format}")

    class_name = class_name_for(tag)
    (model_dir / f"{tag}_inferencer.py").write_text(
        INFERRER_TEMPLATE.format(tag=tag, class_name=class_name, classes=classes, img_size=img_size),
        encoding="utf-8",
    )
    (model_dir / f"{tag}_response_builder.py").write_text(
        RESPONSE_BUILDER_TEMPLATE.format(tag=tag, class_name=class_name),
        encoding="utf-8",
    )

    model_entry = {
        "tag": tag,
        "path": f"model.{model_format}",
        "sessions": sessions,
        "conf_threshold": conf_threshold,
        "iou_threshold": iou_threshold,
        "new_shape": [img_size, img_size],
        "classes": classes,
        "num_classes": len(classes),
    }
    if model_format == "om":
        model_entry["om_path"] = "model.om"

    pipeline = {
        "inference_pipeline": f"{tag}_pipeline",
        "inferencers": [
            {
                "id": f"{tag}_inferencer",
                "inference_file": f"{tag}_inferencer",
                "inference_class": class_name,
                "response_file": f"{tag}_response_builder",
                "response_class": f"{class_name}ResponseBuilder",
                "models": [model_entry],
            }
        ],
    }
    (model_dir / "pipeline.json").write_text(json.dumps(pipeline, ensure_ascii=False, indent=2), encoding="utf-8")

    # inferencer_mapping.json 是 common_service_onnx 的总入口注册表;合并已存在的条目。
    mapping_path = workspace / "inferencer_mapping.json"
    mapping: dict = {}
    if mapping_path.is_file():
        try:
            mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            mapping = {}
    mapping[tag] = f"{tag}_pipeline"
    mapping_path.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")

    (deploy_dir / "logs").mkdir(parents=True, exist_ok=True)
    return workspace


def remove_workspace(deploy_dir: Path) -> None:
    if deploy_dir.exists():
        shutil.rmtree(deploy_dir, ignore_errors=True)


INFERRER_TEMPLATE = 'import base64\nimport os\nimport sys\nimport time\nfrom typing import Tuple\n\nimport numpy as np\nimport onnxruntime as ort\n\nfrom core.abstract_inference import AbstractModelInferencer\nfrom dto.inference_context import InferenceContext\nfrom dto.model_config_dto import ModelConfigDTO\nfrom dto.req_config_dto import ReqConfigDTO\nfrom utils.image_v2_utils import ImageUtilsV2\nfrom utils.logger_utils import LoggerUtils\nfrom utils.str_utils import StrUtils\n\nlogger = LoggerUtils.get_logger(__name__)\n\nTAG = "{tag}"\nCTX_KEY = "{tag}"\nCURRENT_DIR = os.path.dirname(os.path.abspath(__file__))\nPROJECT_ROOT = os.path.dirname(os.path.dirname(CURRENT_DIR))\nACLLITE_PATH = os.path.join(PROJECT_ROOT, "3party", "ACLLite", "python")\n\nsess_options = ort.SessionOptions()\nsess_options.intra_op_num_threads = 1\n\n\nclass {class_name}(AbstractModelInferencer):\n    """YWA 受管 YOLO 检测模型通用推理器(平台部署自动生成,勿手改)。"""\n\n    DEFAULT_INPUT_SIZE = ({img_size}, {img_size})\n    DEFAULT_CLASSES = {classes!r}\n\n    def getconfig(self, model_config: ModelConfigDTO, req_param=None) -> ReqConfigDTO:\n        conf = model_config.conf_threshold\n        iou = model_config.iou_threshold\n        if req_param:\n            conf = getattr(req_param, "conf", conf)\n            iou = getattr(req_param, "iou", iou)\n        return ReqConfigDTO(\n            float(conf),\n            float(iou),\n            model_tag=TAG,\n            extra={{\n                "classes": getattr(model_config, "classes", None) or self.DEFAULT_CLASSES,\n                "num_classes": int(getattr(model_config, "num_classes", 0) or len(self.DEFAULT_CLASSES)),\n            }},\n        )\n\n    def preprocess(self, ctx: InferenceContext, model_configs: dict, req_configs: dict, *args, **kwargs):\n        img = self._decode_image(ctx)\n        ctx.pre_procceed_data[f"{{TAG}}_img"] = img\n\n        model_config = model_configs.get(TAG)\n        if not model_config:\n            return\n        input_size = self._input_size(model_config, self.DEFAULT_INPUT_SIZE)\n        tensor, img_h, img_w = ImageUtilsV2.prepare_input(img, input_size, swapRB=True, is_cls=False)\n        ctx.pre_procceed_data[f"{{TAG}}_tensor"] = tensor\n        ctx.pre_procceed_data[f"{{TAG}}_shape"] = (img_h, img_w)\n        ctx.pre_procceed_data[f"{{TAG}}_input_size"] = input_size\n\n    def coreprocess(self, ctx: InferenceContext, model_configs: dict, req_configs: dict, *args, **kwargs):\n        if TAG not in model_configs:\n            ctx.core_procceed_data[f"{{TAG}}_raw_output"] = None\n            return\n\n        t0 = time.time()\n        tensor = ctx.pre_procceed_data[f"{{TAG}}_tensor"]\n        raw = self._run_session(TAG, tensor)\n        logger.info(f"{{TAG}} 推理耗时: {{time.time() - t0:.4f}}s")\n        ctx.core_procceed_data[f"{{TAG}}_raw_output"] = raw\n\n    def postprocess(self, ctx: InferenceContext, model_configs: dict, req_configs: dict, *args, **kwargs):\n        req_config = req_configs.get(TAG)\n        if not req_config:\n            ctx.post_procceed_data[CTX_KEY] = []\n            return\n\n        raw = ctx.core_procceed_data.get(f"{{TAG}}_raw_output")\n        if raw is None:\n            ctx.post_procceed_data[CTX_KEY] = []\n            return\n\n        img_h, img_w = ctx.pre_procceed_data[f"{{TAG}}_shape"]\n        input_size = ctx.pre_procceed_data[f"{{TAG}}_input_size"]\n        num_classes = req_config.extra.get("num_classes") or len(self.DEFAULT_CLASSES)\n        boxes, scores, classes = ImageUtilsV2.process_output(\n            [raw],\n            req_config.conf_threshold,\n            req_config.iou_threshold,\n            img_h,\n            img_w,\n            input_size,\n            num_classes,\n        )\n\n        class_names = req_config.extra.get("classes") or self.DEFAULT_CLASSES\n        detections = []\n        for box, score, cls_id in zip(boxes, scores, classes):\n            class_name = class_names[int(cls_id)] if int(cls_id) < len(class_names) else str(cls_id)\n            detections.append({{\n                "box": [int(box[0]), int(box[1]), int(box[2]), int(box[3])],\n                "confidence": float(score),\n                "class_name": class_name,\n            }})\n        ctx.post_procceed_data[CTX_KEY] = detections\n\n    def create_inference_session(self, model_config: ModelConfigDTO, device_type: str, device_id: str):\n        device_type_lower = device_type.lower()\n        fixed_device_id = getattr(model_config, "device_id", None)\n        device_id = str(fixed_device_id) if fixed_device_id is not None else str(device_id)\n\n        if device_type_lower in ("npu", "ascend"):\n            om_path = getattr(model_config, "om_path", None)\n            if not om_path:\n                raise ValueError(f"模型 {{model_config.tag}} 在 NPU 模式下缺少 om_path 配置")\n            self._ensure_acllite_path()\n            from acllite_resource import AclLiteResource\n            from acllite_model import AclLiteModel\n            logger.info(f"NPU 模式：加载 .om 模型 {{om_path}}，device_id={{device_id}}")\n            resource = AclLiteResource(device_id=int(device_id))\n            resource.init()\n            return AclLiteModel(om_path, acl_resource=resource, device_id=int(device_id))\n\n        if device_type_lower in ("cuda", "gpu"):\n            providers = [("CUDAExecutionProvider", {{"device_id": device_id}}), "CPUExecutionProvider"]\n        else:\n            providers = ["CPUExecutionProvider"]\n        try:\n            return ort.InferenceSession(model_config.path, sess_options, providers=providers)\n        except Exception as e:\n            logger.warning(f"Fallback to CPU: {{e}}")\n            return ort.InferenceSession(model_config.path, sess_options, providers=["CPUExecutionProvider"])\n\n    @staticmethod\n    def _ensure_acllite_path():\n        if not os.path.isdir(ACLLITE_PATH):\n            raise FileNotFoundError(f"未找到 ACLLite 目录: {{ACLLITE_PATH}}")\n        if ACLLITE_PATH not in sys.path:\n            sys.path.append(ACLLITE_PATH)\n\n    @staticmethod\n    def _decode_image(ctx: InferenceContext) -> np.ndarray:\n        import cv2\n        img = None\n        if not StrUtils.isempty(ctx.base64_image):\n            img = cv2.imdecode(np.frombuffer(base64.urlsafe_b64decode(ctx.base64_image), np.uint8), cv2.IMREAD_COLOR)\n        if img is None and not StrUtils.isempty(ctx.bytes_image):\n            img = cv2.imdecode(np.frombuffer(ctx.bytes_image, np.uint8), cv2.IMREAD_COLOR)\n        if img is None:\n            raise ValueError("图片解码失败")\n        return img\n\n    @staticmethod\n    def _input_size(model_config, default_size: Tuple[int, int]) -> Tuple[int, int]:\n        shape = getattr(model_config, "new_shape", None) if model_config else None\n        return (int(shape[0]), int(shape[1])) if shape else default_size\n\n    def _run_session(self, tag: str, tensor: np.ndarray):\n        result = self.inference_with_timeout(tag, lambda sess: ImageUtilsV2.run_inference_session(sess, tensor))\n        if result is None:\n            raise RuntimeError(f"模型 {{tag}} 推理超时或返回 None")\n        return result\n'

RESPONSE_BUILDER_TEMPLATE = 'from typing import Any, Dict, List\n\nfrom core.abstract_response import AbstractResponseBuilder\nfrom dto.inference_context import InferenceContext\nfrom dto.sgcc_res_dto import AreaPointDTO, PosItemDTO, SgccResultItemDTO\nfrom models.{tag}.{tag}_inferencer import TAG, CTX_KEY\n\nEMPTY_VALUE = "-99998"\n\n\nclass {class_name}ResponseBuilder(AbstractResponseBuilder):\n    """YWA 受管 YOLO 检测模型通用响应构建器(平台部署自动生成,勿手改)。"""\n\n    def sync_response(self, inference_ctxs: List[InferenceContext]) -> List[Dict[str, Any]]:\n        results = []\n        for ctx in inference_ctxs:\n            detections = ctx.post_procceed_data.get(CTX_KEY, [])\n            results.append({{\n                "image_id": getattr(ctx, "image_id", ""),\n                "count": len(detections),\n                "detections": detections,\n            }})\n        return results\n\n    def async_response(self, inference_ctxs: List[InferenceContext]) -> SgccResultItemDTO:\n        max_conf = 0.0\n        values = []\n        pos_list = []\n\n        for ctx in inference_ctxs:\n            detections = ctx.post_procceed_data.get(CTX_KEY, [])\n            for det in detections:\n                box = det["box"]\n                values.append(str(det["class_name"]))\n                max_conf = max(max_conf, float(det["confidence"]))\n                pos_list.append(\n                    PosItemDTO(\n                        areas=[\n                            AreaPointDTO(x=int(box[0]), y=int(box[1])),\n                            AreaPointDTO(x=int(box[2]), y=int(box[3])),\n                        ]\n                    )\n                )\n\n        if not pos_list:\n            return SgccResultItemDTO(\n                type=TAG,\n                value=EMPTY_VALUE,\n                desc="未识别到目标",\n                conf=0.0,\n                pos=[],\n                resImageUrl="",\n            )\n\n        return SgccResultItemDTO(\n            type=TAG,\n            value=",".join(values),\n            desc="正常",\n            conf=round(max_conf, 4),\n            pos=pos_list,\n            resImageUrl="",\n        )\n'
