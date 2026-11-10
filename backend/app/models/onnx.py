from __future__ import annotations

import shutil
from pathlib import Path


def export_fp32_onnx(source_path: Path, output_path: Path, *, batch: int = 1, dynamic: bool = False, imgsz: int = 640, opset: int = 11) -> Path:
    """Export one Ultralytics PT file to a managed FP32 ONNX file."""

    from ultralytics import YOLO

    exported = YOLO(str(source_path)).export(
        format="onnx",
        imgsz=imgsz,
        batch=batch,
        dynamic=dynamic,
        simplify=True,
        nms=False,
        opset=opset,
    )
    source_export = Path(exported).expanduser().resolve()
    if not source_export.is_file():
        raise RuntimeError("Ultralytics did not produce an ONNX file.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if source_export != output_path.resolve():
        shutil.copy2(source_export, output_path)
    return output_path.resolve()
