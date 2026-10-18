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

"""Replace unmasked SAM3 QK/Softmax/V attention patterns with FlashAttentionTik.

The 310P MindIE FlashAttentionTik custom op registered in the local OPP only
accepts Q/K/V inputs. This script still identifies masked attention blocks, but
does not rewrite them because dropping the Add mask before Softmax changes
model semantics.
"""

from __future__ import annotations

import argparse
import os
import shutil
from collections import defaultdict
from pathlib import Path

import onnx
from onnx import TensorProto, helper


# FlashAttentionTik accepts only specific head_dim values. SAM3 DETR attention
# can expose head_dim=32 after optimization, so this script pads it to 40 before
# the custom op and slices the result back to 32 afterwards.
SUPPORTED_HEAD_DIMS = {40, 48, 64, 72, 80, 128, 160, 512}
PADDED_HEAD_DIM = 40

# The optimized SAM3 graph has 44 unmasked attention blocks that should either
# be rewritten or reported as over-limit. Masked attention blocks are counted
# separately because rewriting them without mask support changes semantics.
DEFAULT_EXPECTED_COUNT = 44

# FlashAttentionTik's MindIE TBE implementation validates 4D BNSD inputs with
# batch <= 64 and head_num <= 64. SAM3 window attention naturally appears as
# [bs * 9, heads, seq, dim]. Keeping bs and moving all windows into heads would
# produce heads=144 for ViT blocks, which fails TBE pre-compile, so the rewrite
# keeps both dimensions within the custom-op limits.
MAX_FLASH_4D_BATCH = 64
MAX_FLASH_HEADS = 64


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Patch SAM3 attention to FlashAttentionTik")
    parser.add_argument("--model", required=True, help="Input optimized ONNX path")
    parser.add_argument("--output", required=True, help="Output patched ONNX path")
    parser.add_argument("--batch-size", type=int, required=True, help="Static input batch size")
    parser.add_argument("--expected-count", type=int, default=DEFAULT_EXPECTED_COUNT)
    return parser.parse_args()


def shape_from_value_info(value_info) -> list[int | str | None]:
    dims = []
    for dim in value_info.type.tensor_type.shape.dim:
        if dim.HasField("dim_value") and dim.dim_value > 0:
            dims.append(int(dim.dim_value))
        elif dim.HasField("dim_param") and dim.dim_param:
            dims.append(dim.dim_param)
        else:
            dims.append(None)
    return dims


def external_locations(model) -> set[str]:
    locations = set()
    for tensor in model.graph.initializer:
        if tensor.data_location != TensorProto.EXTERNAL:
            continue
        metadata = {entry.key: entry.value for entry in tensor.external_data}
        location = metadata.get("location")
        if location:
            locations.add(location)
    return locations


def link_external_data_locations(model_path: Path, source_dirs: list[Path]) -> None:
    for location in external_locations(onnx.load(str(model_path), load_external_data=False)):
        target = model_path.parent / location
        if target.exists():
            continue
        for source_dir in source_dirs:
            source = source_dir / location
            if not source.exists():
                continue
            try:
                os.link(source, target)
            except OSError:
                try:
                    os.symlink(source, target)
                except OSError:
                    shutil.copy2(source, target)
            break


def build_maps(graph):
    producer = {}
    consumers = defaultdict(list)
    for index, node in enumerate(graph.node):
        for output in node.output:
            producer[output] = index
        for input_name in node.input:
            consumers[input_name].append(index)
    return producer, consumers


def single_consumer(consumers, value_name, nodes, op_type):
    matches = [index for index in consumers.get(value_name, []) if nodes[index].op_type == op_type]
    if len(matches) != 1:
        return None
    return matches[0]


def is_attention_softmax(name: str) -> bool:
    attention_softmax_tokens = (
        "/self_attn/Softmax",
        "/cross_attn/Softmax",
        "/text_cross_attn/Softmax",
        "/vision_cross_attn/Softmax",
        "/prompt_cross_attn/Softmax",
        "/attention/Softmax",
    )
    for token in attention_softmax_tokens:
        if token in name:
            return True
    return False


def has_valid_attention_shapes(q_shape_raw, kt_shape_raw, v_shape_raw) -> bool:
    if not q_shape_raw or not kt_shape_raw or not v_shape_raw:
        return False
    if len(q_shape_raw) != 4:
        return False
    if len(kt_shape_raw) != 4:
        return False
    if len(v_shape_raw) != 4:
        return False
    return True


def find_qk_path(nodes, producer, softmax_input: str):
    """Return (qk_index, scale_input, remove_indices, dropped_mask)."""
    stack = [(softmax_input, [])]
    seen = set()
    best = None
    while stack:
        value_name, path = stack.pop()
        if value_name in seen:
            continue
        seen.add(value_name)
        index = producer.get(value_name)
        if index is None:
            continue
        node = nodes[index]
        next_path = path + [index]
        if node.op_type == "MatMul":
            # The QK MatMul may be followed by Cast/Mul/Add before Softmax.
            # An Add in this path normally carries an attention mask. The local
            # FlashAttentionTik op variant used here has no mask input, so those
            # blocks must be skipped instead of dropping the mask.
            best = (index, None, next_path, any(nodes[item].op_type == "Add" for item in path))
            break
        if node.op_type not in {"Add", "Mul", "Cast"}:
            continue
        for input_name in node.input:
            input_index = producer.get(input_name)
            if input_index is not None:
                stack.append((input_name, next_path))

    if best is None:
        return None

    qk_index, _, path, dropped_mask = best
    qk_output = nodes[qk_index].output[0]
    scale_input = None
    for index in path:
        node = nodes[index]
        if node.op_type != "Mul":
            continue
        if qk_output in node.input:
            scale_input = next((item for item in node.input if item != qk_output), None)
            break
    return qk_index, scale_input, set(path), dropped_mask


def static_dim(value, fallback: int | None = None) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    return fallback


def infer_first_dim(name: str, q_seq: int, batch_size: int) -> int:
    # ViT window attention flattens 3x3 windows into the leading dimension.
    # For bs=8 this becomes first_dim=72, which must be redistributed before
    # FlashAttentionTik because its 4D batch dimension cannot exceed 64.
    if "/vision_encoder/backbone/" in name and q_seq == 576:
        return batch_size * 9
    return batch_size


def infer_heads(name: str, q_shape: list[int | str | None], head_dim: int) -> int | None:
    heads = static_dim(q_shape[1] if len(q_shape) > 1 else None)
    if heads is not None:
        return heads
    # Shape inference may leave the head axis symbolic after onnxslim. These
    # values come from the SAM3 architecture and are required only when the ONNX
    # value_info does not provide concrete BNSD dimensions.
    if "/text_encoder/" in name or "/vision_encoder/backbone/" in name:
        return 16
    if "/detr_encoder/" in name or "/detr_decoder/" in name or "/mask_decoder/" in name:
        return 8
    return None


def infer_head_dim(name: str, q_shape: list[int | str | None]) -> int | None:
    head_dim = static_dim(q_shape[3] if len(q_shape) > 3 else None)
    if head_dim is not None:
        return head_dim
    # Some onnxslim shape-inference paths leave BNSD dims symbolic. Keep the
    # fallback explicit and SAM3-specific instead of deriving dimensions from
    # node names during graph rewrite.
    if "/detr_encoder/" in name or "/detr_decoder/" in name or "/mask_decoder/" in name:
        return 32
    if "/text_encoder/" in name:
        return 64
    if "/vision_encoder/backbone/" in name:
        return 72
    return None


def infer_attention_lengths(name: str, q_seq: int | None, kv_seq: int | None) -> tuple[int | None, int | None]:
    if q_seq is not None and kv_seq is not None:
        return q_seq, kv_seq
    # These sequence lengths are the SAM3 attention contracts after export:
    # 5184 is the image token grid, 201 is decoder queries with the extra token,
    # 200 is object queries, and 32 is the fixed text prompt length.
    if "/detr_encoder/" in name and "/self_attn/" in name:
        return 5184, 5184
    if "/detr_encoder/" in name and "/cross_attn/" in name:
        return 5184, 32
    if "/detr_decoder/" in name and "/self_attn/" in name:
        return 201, 201
    if "/detr_decoder/" in name and "/text_cross_attn/" in name:
        return 200, 32
    if "/detr_decoder/" in name and "/vision_cross_attn/" in name:
        return 200, 5184
    if "/mask_decoder/prompt_cross_attn/" in name:
        return 5184, 32
    return q_seq, kv_seq


def redistribute_batch_heads(first_dim: int, heads: int) -> tuple[int, int] | None:
    """Move batch/window groups into heads while respecting FlashAttentionTik limits."""
    if first_dim <= MAX_FLASH_4D_BATCH and heads <= MAX_FLASH_HEADS:
        return first_dim, heads

    # Preserve total attention groups while changing only the B/H split. Example:
    # bs=8 ViT window attention is [72, 16, 576, 72]; this rewrites the Flash
    # input to [18, 64, 576, 72], then restores the output back to [72, 16, ...].
    total_groups = first_dim * heads
    for new_heads in range(min(MAX_FLASH_HEADS, total_groups), 0, -1):
        if total_groups % new_heads != 0:
            continue
        new_first_dim = total_groups // new_heads
        if new_first_dim <= MAX_FLASH_4D_BATCH:
            return new_first_dim, new_heads
    return None


def make_value_info(name: str, elem_type: int, dims: list[int]):
    return helper.make_tensor_value_info(name, elem_type, dims)


def make_i64_tensor(name: str, values: list[int]):
    return helper.make_tensor(name, TensorProto.INT64, [len(values)], values)


def append_flash_nodes(
    graph,
    prefix: str,
    query_input: str,
    key_transposed_input: str,
    value_input: str,
    scale_input: str | None,
    output_name: str,
    output_dtype: int,
    q_shape: list[int],
    kv_shape: list[int],
    flash_q_shape: list[int] | None = None,
    flash_kv_shape: list[int] | None = None,
) -> list[onnx.NodeProto]:
    head_dim = q_shape[3]
    flash_q_shape = flash_q_shape or q_shape
    flash_kv_shape = flash_kv_shape or kv_shape
    needs_restore = flash_q_shape != q_shape
    padded = head_dim not in SUPPORTED_HEAD_DIMS
    if padded and head_dim >= PADDED_HEAD_DIM:
        raise RuntimeError(f"unsupported head_dim={head_dim}, cannot pad to {PADDED_HEAD_DIM}")

    # Only smaller unsupported dims are padded. SAM3's 32-dim DETR attention is
    # padded to 40 because 40 is the smallest supported FlashAttentionTik dim.
    flash_q_padded_shape = [flash_q_shape[0], flash_q_shape[1], flash_q_shape[2], PADDED_HEAD_DIM] if padded else flash_q_shape
    flash_kv_padded_shape = [flash_kv_shape[0], flash_kv_shape[1], flash_kv_shape[2], PADDED_HEAD_DIM] if padded else flash_kv_shape

    names = {
        "query_raw": f"{prefix}_q_raw",
        "query_cast": f"{prefix}_q_fp16_cast",
        "query": f"{prefix}_q_fp16",
        "key_raw": f"{prefix}_k_raw",
        "key_cast": f"{prefix}_k_fp16_cast",
        "key": f"{prefix}_k_fp16",
        "value_cast": f"{prefix}_v_fp16_cast",
        "value": f"{prefix}_v_fp16",
        "q_shape": f"{prefix}_q_shape",
        "kv_shape": f"{prefix}_kv_shape",
        "flash_q_shape": f"{prefix}_flash_q_shape",
        "flash_kv_shape": f"{prefix}_flash_kv_shape",
        "pad_width": f"{prefix}_pad_width",
        "pad_value": f"{prefix}_pad_value",
        "query_pad_raw": f"{prefix}_q_padded_raw",
        "query_pad": f"{prefix}_q_padded",
        "key_pad_raw": f"{prefix}_k_padded_raw",
        "key_pad": f"{prefix}_k_padded",
        "value_pad_raw": f"{prefix}_v_padded_raw",
        "value_pad": f"{prefix}_v_padded",
        "flash_output": f"{prefix}_flash_y_fp16",
        "slice_starts": f"{prefix}_slice_starts",
        "slice_ends": f"{prefix}_slice_ends",
        "slice_axes": f"{prefix}_slice_axes",
        "slice_steps": f"{prefix}_slice_steps",
        "sliced_output": f"{prefix}_flash_y_sliced_fp16",
        "restore_shape": f"{prefix}_restore_shape",
        "restored_output": f"{prefix}_flash_y_restored_fp16",
    }

    # FlashAttentionTik ATC shape inference requires concrete 4D BNSD inputs.
    # Keep these static reshapes even when batch/head are not redistributed.
    graph.initializer.extend(
        [
            make_i64_tensor(names["q_shape"], flash_q_shape),
            make_i64_tensor(names["kv_shape"], flash_kv_shape),
        ]
    )
    query_source = names["query_raw"]
    nodes = []
    if scale_input:
        # Preserve the original QK scaling by multiplying Q before FlashAttentionTik.
        # This is equivalent to scaling the QK score matrix and avoids changing
        # model numerics while removing the old QK/Softmax/V subgraph.
        nodes.append(helper.make_node("Mul", [query_input, scale_input], [names["query_raw"]], name=f"{prefix}_scale_q"))
    else:
        query_source = query_input
    nodes.extend(
        [
            helper.make_node("Cast", [query_source], [names["query_cast"]], name=f"{prefix}_cast_q_fp16", to=TensorProto.FLOAT16),
            helper.make_node("Reshape", [names["query_cast"], names["q_shape"]], [names["query"]], name=f"{prefix}_reshape_q_static"),
            helper.make_node("Transpose", [key_transposed_input], [names["key_raw"]], name=f"{prefix}_k_transpose_to_bhnd", perm=[0, 1, 3, 2]),
            helper.make_node("Cast", [names["key_raw"]], [names["key_cast"]], name=f"{prefix}_cast_k_fp16", to=TensorProto.FLOAT16),
            helper.make_node("Reshape", [names["key_cast"], names["kv_shape"]], [names["key"]], name=f"{prefix}_reshape_k_static"),
            helper.make_node("Cast", [value_input], [names["value_cast"]], name=f"{prefix}_cast_v_fp16", to=TensorProto.FLOAT16),
            helper.make_node("Reshape", [names["value_cast"], names["kv_shape"]], [names["value"]], name=f"{prefix}_reshape_v_static"),
        ]
    )

    flash_inputs = [names["query"], names["key"], names["value"]]
    if padded:
        # FlashAttentionTik cannot consume head_dim=32 directly. Pad Q/K/V on
        # the last axis, run the custom op at head_dim=40, then slice the output
        # back before reconnecting to the original graph.
        graph.initializer.extend(
            [
                make_i64_tensor(names["flash_q_shape"], flash_q_padded_shape),
                make_i64_tensor(names["flash_kv_shape"], flash_kv_padded_shape),
                helper.make_tensor(names["pad_width"], TensorProto.INT64, [8], [0, 0, 0, 0, 0, 0, 0, PADDED_HEAD_DIM - head_dim]),
                helper.make_tensor(names["pad_value"], TensorProto.FLOAT16, [], [0]),
                helper.make_tensor(names["slice_starts"], TensorProto.INT64, [1], [0]),
                helper.make_tensor(names["slice_ends"], TensorProto.INT64, [1], [head_dim]),
                helper.make_tensor(names["slice_axes"], TensorProto.INT64, [1], [3]),
                helper.make_tensor(names["slice_steps"], TensorProto.INT64, [1], [1]),
            ]
        )
        nodes.extend(
            [
                helper.make_node("Pad", [names["query"], names["pad_width"], names["pad_value"]], [names["query_pad_raw"]], name=f"{prefix}_pad_q", mode="constant"),
                helper.make_node("Reshape", [names["query_pad_raw"], names["flash_q_shape"]], [names["query_pad"]], name=f"{prefix}_reshape_padded_q"),
                helper.make_node("Pad", [names["key"], names["pad_width"], names["pad_value"]], [names["key_pad_raw"]], name=f"{prefix}_pad_k", mode="constant"),
                helper.make_node("Reshape", [names["key_pad_raw"], names["flash_kv_shape"]], [names["key_pad"]], name=f"{prefix}_reshape_padded_k"),
                helper.make_node("Pad", [names["value"], names["pad_width"], names["pad_value"]], [names["value_pad_raw"]], name=f"{prefix}_pad_v", mode="constant"),
                helper.make_node("Reshape", [names["value_pad_raw"], names["flash_kv_shape"]], [names["value_pad"]], name=f"{prefix}_reshape_padded_v"),
            ]
        )
        flash_inputs = [names["query_pad"], names["key_pad"], names["value_pad"]]

    flash_output_name = output_name if output_dtype == TensorProto.FLOAT16 and not padded and not needs_restore else names["flash_output"]
    nodes.append(helper.make_node("FlashAttentionTik", flash_inputs, [flash_output_name], name=f"{prefix}_flashattentiontik"))

    cast_source = flash_output_name
    if padded:
        nodes.append(
            helper.make_node(
                "Slice",
                [names["flash_output"], names["slice_starts"], names["slice_ends"], names["slice_axes"], names["slice_steps"]],
                [names["sliced_output"]],
                name=f"{prefix}_slice_flash_y",
            )
        )
        cast_source = names["sliced_output"]
    if needs_restore:
        # The B/H redistribution is internal to FlashAttentionTik. Restore the
        # original output shape so downstream ONNX nodes see the same contract
        # as the removed MatMul output.
        graph.initializer.append(make_i64_tensor(names["restore_shape"], q_shape))
        restore_output = output_name if output_dtype == TensorProto.FLOAT16 else names["restored_output"]
        nodes.append(
            helper.make_node(
                "Reshape",
                [cast_source, names["restore_shape"]],
                [restore_output],
                name=f"{prefix}_restore_y_shape",
            )
        )
        cast_source = restore_output
    if output_dtype != TensorProto.FLOAT16:
        nodes.append(helper.make_node("Cast", [cast_source], [output_name], name=f"{prefix}_cast_y_original", to=output_dtype))

    graph.value_info.extend(
        [
            make_value_info(names["query"], TensorProto.FLOAT16, flash_q_shape),
            make_value_info(names["key"], TensorProto.FLOAT16, flash_kv_shape),
            make_value_info(names["value"], TensorProto.FLOAT16, flash_kv_shape),
            make_value_info(names["flash_output"], TensorProto.FLOAT16, flash_q_padded_shape),
        ]
    )
    return nodes


def patch_all_flashattentiontik(
    input_path: Path,
    output_path: Path,
    batch_size: int,
    expected_count: int,
) -> tuple[list[str], list[str], list[str], list[str]]:
    model = onnx.load(str(input_path), load_external_data=False)
    graph = model.graph
    nodes = list(graph.node)
    producer, consumers = build_maps(graph)
    value_infos = list(graph.input) + list(graph.value_info) + list(graph.output)
    shape_map = {item.name: shape_from_value_info(item) for item in value_infos}
    dtype_map = {item.name: item.type.tensor_type.elem_type for item in value_infos}

    remove_indices = set()
    insert_before = defaultdict(list)
    patched = []
    skipped_masked = []
    skipped_over_limit = []
    redistributed = []

    for softmax_index, softmax_node in enumerate(nodes):
        # Match only known SAM3 attention Softmax nodes. Generic Softmax nodes
        # may belong to non-attention logic and must not be rewritten.
        if softmax_node.op_type != "Softmax" or not is_attention_softmax(softmax_node.name):
            continue
        av_index = single_consumer(consumers, softmax_node.output[0], nodes, "MatMul")
        if av_index is None:
            continue
        qk_path = find_qk_path(nodes, producer, softmax_node.input[0])
        if qk_path is None:
            continue
        qk_index, scale_input, path_indices, dropped_mask = qk_path
        if dropped_mask:
            # Masked attention is intentionally left untouched because this OPP
            # registration exposes only Q/K/V inputs for FlashAttentionTik.
            skipped_masked.append(softmax_node.name)
            continue
        qk_node = nodes[qk_index]
        av_node = nodes[av_index]
        if len(qk_node.input) < 2 or len(av_node.input) < 2:
            continue

        query_input = qk_node.input[0]
        key_transposed_input = qk_node.input[1]
        value_input = av_node.input[1]
        q_shape_raw = shape_map.get(query_input)
        kt_shape_raw = shape_map.get(key_transposed_input)
        v_shape_raw = shape_map.get(value_input)
        score_shape = shape_map.get(softmax_node.input[0])
        if not has_valid_attention_shapes(q_shape_raw, kt_shape_raw, v_shape_raw):
            continue

        head_dim = infer_head_dim(softmax_node.name, q_shape_raw)
        q_seq = static_dim(q_shape_raw[2], static_dim(score_shape[2] if score_shape and len(score_shape) == 4 else None))
        kv_seq = static_dim(v_shape_raw[2], static_dim(score_shape[3] if score_shape and len(score_shape) == 4 else None))
        q_seq, kv_seq = infer_attention_lengths(softmax_node.name, q_seq, kv_seq)
        if head_dim is None or q_seq is None or kv_seq is None:
            continue
        heads = infer_heads(softmax_node.name, q_shape_raw, head_dim)
        if heads is None:
            continue
        first_dim = infer_first_dim(softmax_node.name, q_seq, batch_size)
        redistributed_shape = redistribute_batch_heads(first_dim, heads)
        if redistributed_shape is None:
            skipped_over_limit.append(softmax_node.name)
            continue
        q_shape = [first_dim, heads, q_seq, head_dim]
        kv_shape = [first_dim, heads, kv_seq, head_dim]
        flash_first_dim, flash_heads = redistributed_shape
        flash_q_shape = [flash_first_dim, flash_heads, q_seq, head_dim]
        flash_kv_shape = [flash_first_dim, flash_heads, kv_seq, head_dim]
        if flash_q_shape != q_shape:
            redistributed.append(softmax_node.name)

        output_name = av_node.output[0]
        output_dtype = dtype_map.get(output_name, TensorProto.FLOAT)
        prefix = f"sam3_flash_{len(patched)}"
        flash_nodes = append_flash_nodes(
            graph,
            prefix,
            query_input,
            key_transposed_input,
            value_input,
            scale_input,
            output_name,
            output_dtype,
            q_shape,
            kv_shape,
            flash_q_shape,
            flash_kv_shape,
        )
        insert_before[qk_index].extend(flash_nodes)
        remove_indices.update(path_indices)
        remove_indices.update([softmax_index, av_index])
        patched.append(softmax_node.name)

    if len(patched) + len(skipped_over_limit) != expected_count:
        # Keep this gate strict: a lower count usually means onnxslim or shape
        # inference changed node names/shapes and the generated graph should be
        # reviewed before ATC conversion.
        raise RuntimeError(
            f"processed {len(patched) + len(skipped_over_limit)} attention blocks, expected {expected_count}"
        )

    new_nodes = []
    for index, node in enumerate(nodes):
        new_nodes.extend(insert_before.get(index, []))
        if index not in remove_indices:
            new_nodes.append(node)

    graph.ClearField("node")
    graph.node.extend(new_nodes)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(output_path))
    link_external_data_locations(output_path, [input_path.parent])
    return patched, skipped_masked, skipped_over_limit, redistributed


def main() -> None:
    args = parse_args()
    if args.batch_size <= 0:
        raise ValueError("--batch-size must be a positive integer")
    input_path = Path(args.model).resolve()
    output_path = Path(args.output).resolve()
    patched, _, skipped_over_limit, redistributed = patch_all_flashattentiontik(
        input_path,
        output_path,
        args.batch_size,
        args.expected_count,
    )
    final_count = sum(
        node.op_type == "FlashAttentionTik"
        for node in onnx.load(str(output_path), load_external_data=False).graph.node
    )
    print(f"input={input_path}")
    print(f"output={output_path}")
    print(f"flashattentiontik_patched={len(patched)}")
    print(f"flashattentiontik_redistributed={len(redistributed)}")
    print(f"flashattentiontik_skipped_over_limit={len(skipped_over_limit)}")
    print(f"final_FlashAttentionTik={final_count}")


if __name__ == "__main__":
    main()
