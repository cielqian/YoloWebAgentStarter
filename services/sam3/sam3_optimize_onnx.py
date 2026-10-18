#!/usr/bin/env python3
# Copyright 2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Optimize SAM3 ONNX before ATC conversion."""

import argparse
import shutil
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxslim import slim


def save_model_external(model, path: Path) -> None:
    """Save model with external data to prevent >2GB protobuf errors."""
    data_path = path.with_name(path.name + ".data")
    if data_path.exists():
        data_path.unlink()

    onnx.save_model(
        model, str(path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_path.name,
        size_threshold=1024
    )


def patch_dynamic_shapes(model_path: Path, profiles: list) -> None:
    """Freeze dynamic output shapes using dummy inference (Needed for ATC)."""
    model = onnx.load(str(model_path), load_external_data=True)
    if not profiles:
        return

    # Extract graph inputs (excluding weights)
    init_names = {init.name for init in model.graph.initializer}
    inputs = [v for v in model.graph.input if v.name not in init_names]

    # Run dummy inference to observe real output shapes
    sess_opts = ort.SessionOptions()
    sess_opts.log_severity_level = 3  # Suppress ORT warnings
    session = ort.InferenceSession(str(model_path), sess_options=sess_opts, providers=["CPUExecutionProvider"])

    observed_shapes = {}
    for profile in profiles:
        feeds = {}
        for val in inputs:
            shape = profile.get(val.name)
            if not shape:
                shape = [int(d.dim_value or d.dim_param or 1) for d in val.type.tensor_type.shape.dim]
            dtype = np.float32 if val.type.tensor_type.elem_type == 1 else np.int64
            feeds[val.name] = np.zeros(shape, dtype=dtype)

        outputs = session.run(None, feeds)
        for meta, out_val in zip(session.get_outputs(), outputs):
            observed_shapes.setdefault(meta.name, []).append(list(out_val.shape))

    # Apply static shapes based on observed runs
    patched = False
    for output in model.graph.output:
        shapes = observed_shapes.get(output.name)
        if not shapes or len({len(s) for s in shapes}) != 1:
            continue

        output.type.tensor_type.shape.ClearField("dim")
        for axis in range(len(shapes[0])):
            values = {s[axis] for s in shapes}
            dim = output.type.tensor_type.shape.dim.add()

            if len(values) == 1:
                dim.dim_value = values.pop()
            else:
                dim.dim_param = f"{output.name}_dim{axis}"
        patched = True

    if patched:
        save_model_external(model, model_path)


def parse_shape_profiles(items: list) -> list:
    """Parse string profile to dict: 'name:dim1,dim2' -> {'name': [dim1, dim2]}"""
    profiles = []
    for item in items:
        profile = {}
        for part in item.split(";"):
            part = part.strip()
            if part:
                name, shape = part.split(":", 1)
                profile[name.strip()] = [int(d) for d in shape.split(",")]
        profiles.append(profile)
    return profiles


def main() -> None:
    parser = argparse.ArgumentParser(description="Optimize SAM3 ONNX for ATC")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--probe-shape-profile", action="append", default=[])
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    out_dir = Path(args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    optimized_onnx = out_dir / "optimized_onnx.onnx"
    optimized_data = out_dir / "optimized_onnx.onnx.data"
    profiles = parse_shape_profiles(args.probe_shape_profile)

    print("[*] Starting SAM3 ONNX optimization pipeline...")

    # Step 1: Pre-process & Dynamic Shape Patching
    if profiles:
        target_onnx = out_dir / "original.onnx"
        print(f"[*] Copying model for safe shape patching -> {target_onnx.name}")
        save_model_external(onnx.load(str(model_path), load_external_data=True), target_onnx)
        patch_dynamic_shapes(target_onnx, profiles)
    else:
        print("[*] No shape profiles provided. Direct pass to ONNXSlim.")
        target_onnx = model_path

    # Step 2: Graph Optimization (ONNXSlim)
    print(f"[*] Running ONNXSlim optimization -> {optimized_onnx.name}")
    if optimized_onnx.exists():
        optimized_onnx.unlink()
    if optimized_data.exists():
        optimized_data.unlink()

    slim(
        str(target_onnx),
        output_model=str(optimized_onnx),
        save_as_external_data=True,
        no_shape_infer=False
    )

    # Step 3: Full Shape Inference (Crucial for Downstream Graph Matching)
    print("[*] Inferring detailed shapes (data_prop=True)...")
    with tempfile.TemporaryDirectory(dir=str(out_dir)) as tmp_dir:
        tmp_onnx = Path(tmp_dir) / optimized_onnx.name

        onnx.shape_inference.infer_shapes_path(
            str(optimized_onnx),
            str(tmp_onnx),
            strict_mode=False,
            data_prop=True
        )

        # Safely replace the slimmed model with the fully-inferred one
        shutil.move(str(tmp_onnx), str(optimized_onnx))
        tmp_data = tmp_onnx.with_name(tmp_onnx.name + ".data")
        if tmp_data.exists():
            shutil.move(str(tmp_data), str(optimized_data))

    # Step 4: Cleanup temporary files
    if profiles and target_onnx.exists():
        target_onnx.unlink()
        target_data = target_onnx.with_name(target_onnx.name + ".data")
        if target_data.exists():
            target_data.unlink()

    print(f"[*] Optimization finished successfully! Model ready at: {optimized_onnx}")


if __name__ == "__main__":
    main()
