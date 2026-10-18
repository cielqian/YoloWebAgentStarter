# Copyright 2026 Huawei Technologies Co., Ltd
# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved
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

import argparse
import importlib
import os
import sys
from pathlib import Path

from PIL import Image

# CPU ONNX export does not require auto-loading torch_npu.
os.environ.setdefault("TORCH_DEVICE_BACKEND_AUTOLOAD", "0")

torch = importlib.import_module("torch")
nn = importlib.import_module("torch.nn")
F = importlib.import_module("torch.nn.functional")
sam3_module = importlib.import_module("transformers.models.sam3")
Sam3Processor = sam3_module.Sam3Processor
Sam3Model = sam3_module.Sam3Model
modeling_sam3 = sam3_module.modeling_sam3


def normalize_target_device(target_device):
    return target_device.upper()


def use_eager_attention(target_device):
    return normalize_target_device(target_device) == "300I"


class MatMulPatchEmbedding(nn.Module):
    """Replace ViT patch Conv2d with an equivalent MatMul for ONNX export."""

    def __init__(self, original_patch_embed):
        super().__init__()
        self.patch_size = original_patch_embed.patch_size

        conv_layer = original_patch_embed.projection
        self.weight = nn.Parameter(conv_layer.weight.data.view(conv_layer.out_channels, -1))
        if conv_layer.bias is not None:
            self.bias = nn.Parameter(conv_layer.bias.data)
        else:
            self.register_parameter("bias", None)

    def forward(self, pixel_values):
        batch_size, channels, height, width = pixel_values.shape
        patch_h, patch_w = self.patch_size
        valid_h = height // patch_h * patch_h
        valid_w = width // patch_w * patch_w
        if height != valid_h or width != valid_w:
            pixel_values = pixel_values[:, :, :valid_h, :valid_w]

        out_h = valid_h // patch_h
        out_w = valid_w // patch_w
        patches = pixel_values.reshape(batch_size, channels, out_h, patch_h, out_w, patch_w)
        patches = patches.permute(0, 2, 4, 1, 3, 5).reshape(
            batch_size,
            out_h * out_w,
            channels * patch_h * patch_w,
        )
        return F.linear(patches, self.weight, self.bias)


def apply_rotary_pos_emb_matrix(query, key, cos, sin, rotation_matrix):
    query_float = query.float()
    key_float = key.float()
    query_rotated = torch.matmul(query_float, rotation_matrix)
    key_rotated = torch.matmul(key_float, rotation_matrix)
    query_embed = query_float * cos + query_rotated * sin
    key_embed = key_float * cos + key_rotated * sin
    return query_embed.type_as(query), key_embed.type_as(key)


class FusedSam3ViTRoPEAttention(nn.Module):
    """Fuse ViT QKV projection and export RoPE as MatMul."""

    def __init__(self, original_attention):
        super().__init__()
        self.config = original_attention.config
        self.hidden_size = original_attention.hidden_size
        self.num_attention_heads = original_attention.num_attention_heads
        self.head_dim = original_attention.head_dim
        self.attention_dropout = original_attention.attention_dropout
        self.is_causal = getattr(original_attention, "is_causal", False)

        has_bias = original_attention.q_proj.bias is not None
        self.qkv_proj = nn.Linear(self.hidden_size, 3 * self.hidden_size, bias=has_bias)
        with torch.no_grad():
            q_weight = original_attention.q_proj.weight.data
            k_weight = original_attention.k_proj.weight.data
            v_weight = original_attention.v_proj.weight.data
            self.qkv_proj.weight.data = torch.cat([q_weight, k_weight, v_weight], dim=0)

            if has_bias:
                q_bias = original_attention.q_proj.bias.data
                k_bias = original_attention.k_proj.bias.data
                v_bias = original_attention.v_proj.bias.data
                self.qkv_proj.bias.data = torch.cat([q_bias, k_bias, v_bias], dim=0)

        self.o_proj = original_attention.o_proj
        rotation_matrix = torch.zeros(self.head_dim, self.head_dim)
        for index in range(0, self.head_dim, 2):
            rotation_matrix[index, index + 1] = 1.0
            rotation_matrix[index + 1, index] = -1.0
        self.register_buffer("rope_rot_matrix", rotation_matrix, persistent=False)

    def forward(self, hidden_states, position_embeddings, **kwargs):
        batch_size, height, width, _ = hidden_states.shape
        seq_len = height * width
        qkv = self.qkv_proj(hidden_states)
        qkv = qkv.view(batch_size, seq_len, 3, self.num_attention_heads, self.head_dim)
        qkv = qkv.permute(2, 0, 3, 1, 4)
        query, key, value = qkv.unbind(0)

        cos, sin = position_embeddings
        query, key = apply_rotary_pos_emb_matrix(
            query,
            key,
            cos,
            sin,
            self.rope_rot_matrix,
        )
        attn_output, _ = modeling_sam3.eager_attention_forward(
            self,
            query,
            key,
            value,
            attention_mask=None,
            dropout=0.0 if not self.training else self.attention_dropout,
            is_causal=self.is_causal,
            **kwargs,
        )
        attn_output = attn_output.reshape(batch_size, height, width, -1)
        attn_output = self.o_proj(attn_output)
        return attn_output, None


def apply_export_optimizations(model):
    patch_embeddings = model.vision_encoder.backbone.embeddings.patch_embeddings
    model.vision_encoder.backbone.embeddings.patch_embeddings = MatMulPatchEmbedding(patch_embeddings)
    replaced = 0
    for layer in model.vision_encoder.backbone.layers:
        layer.attention = FusedSam3ViTRoPEAttention(layer.attention)
        replaced += 1
    print(f"Export optimization enabled: patch_embedding=matmul, vit_qkv_rope={replaced}")


def parse_args():
    parser = argparse.ArgumentParser(description="SAM3 ONNX 导出（展平输入格式）")
    parser.add_argument("--model_path", type=str, required=True,
                        help="SAM3 模型目录路径（必需）")
    parser.add_argument("--target_device", type=str.upper, default="800I",
                        help="目标硬件类型。300I 使用 eager attention，其它取值使用模型默认 attention")
    parser.add_argument("--output_dir", type=str, default="./sam3_onnx",
                        help="ONNX 输出目录")
    parser.add_argument("--output_name", type=str, default="sam3.onnx",
                        help="ONNX 文件名，默认无需设置")
    parser.add_argument("--opset_version", type=int, default=17,
                        help="ONNX opset 版本")
    parser.add_argument("--num_threads", type=int, default=32,
                        help="CPU 线程数")
    parser.add_argument("--export_device", type=str, default="cpu",
                        help="导出时使用的 PyTorch 设备")
    parser.add_argument("--image_path", type=str, default="./truck.jpg",
                        help="导出校验使用的示例图片")
    parser.add_argument("--prompt", type=str, default="truck",
                        help="导出校验使用的文本提示")
    parser.add_argument("--skip_onnx_validation", action="store_true",
                        help="跳过 ONNX 结构与 Runtime 验证")
    return parser.parse_args()


def set_thread_env(num_threads):
    os.environ["OPENBLAS_NUM_THREADS"] = str(num_threads)
    os.environ["MKL_NUM_THREADS"] = str(num_threads)
    os.environ["OMP_NUM_THREADS"] = str(num_threads)
    print(f"线程数配置: {num_threads}")


def load_model_and_processor(model_path, device, target_device):
    print(f"从 {model_path} 加载模型...")
    model_kwargs = {"local_files_only": True}
    if use_eager_attention(target_device):
        model_kwargs["attn_implementation"] = "eager"
    model = Sam3Model.from_pretrained(model_path, **model_kwargs).to(device)
    apply_export_optimizations(model)
    processor = Sam3Processor.from_pretrained(model_path, local_files_only=True)
    model.eval()
    attention_mode = "eager" if use_eager_attention(target_device) else "model default"
    print(f"模型加载完成，attention implementation = {attention_mode}")
    return model, processor


def prepare_sample_input(processor, image_path, prompt, device):
    print(f"准备示例输入: 图片={image_path}, 提示='{prompt}'")
    image = Image.open(image_path).convert("RGB")
    inputs = processor(images=image, text=prompt, return_tensors="pt")
    pixel_values = inputs["pixel_values"].to(device)
    input_ids = inputs["input_ids"].to(device)
    attention_mask = inputs["attention_mask"].to(device)
    print(f"  pixel_values shape: {pixel_values.shape}")
    print(f"  input_ids shape:    {input_ids.shape}")
    print(f"  attention_mask shape: {attention_mask.shape}")
    return pixel_values, input_ids, attention_mask


class Sam3FlatBatchONNXWrapper(nn.Module):
    """SAM3 展平输入包装器，用于 ONNX 导出，避免动态索引"""

    def __init__(self, sam3_model):
        super().__init__()
        self.sam3 = sam3_model
        self.num_decoder_layers = sam3_model.config.detr_decoder_config.num_layers

    def forward(self, img_pixel_values, img_input_ids, img_attention_mask):
        # 图像编码
        vision_outputs = self.sam3.vision_encoder(img_pixel_values)

        # 文本编码
        text_outputs = self.sam3.get_text_features(
            input_ids=img_input_ids,
            attention_mask=img_attention_mask,
        )
        text_hidden = text_outputs.last_hidden_state
        text_features = self.sam3.text_projection(text_hidden)

        # FPN 特征与位置编码
        fpn_hidden_states = vision_outputs.fpn_hidden_states[:-1]
        fpn_position_encoding = vision_outputs.fpn_position_encoding[:-1]

        text_mask = img_attention_mask.bool()

        # DETR 编码器
        encoder_outputs = self.sam3.detr_encoder(
            vision_features=[fpn_hidden_states[-1]],
            text_features=text_features,
            vision_pos_embeds=[fpn_position_encoding[-1]],
            text_mask=text_mask,
        )

        # DETR 解码器
        decoder_outputs = self.sam3.detr_decoder(
            vision_features=encoder_outputs.last_hidden_state,
            text_features=encoder_outputs.text_features,
            vision_pos_encoding=encoder_outputs.pos_embeds_flattened,
            text_mask=text_mask,
            spatial_shapes=encoder_outputs.spatial_shapes,
        )

        # 显式获取最后一层隐藏状态
        intermediate_hidden = decoder_outputs.intermediate_hidden_states
        if isinstance(intermediate_hidden, (tuple, list)):
            stacked_hidden = torch.stack(intermediate_hidden, dim=0)
            last_decoder_hidden = stacked_hidden[self.num_decoder_layers - 1]
        else:
            last_decoder_hidden = intermediate_hidden[self.num_decoder_layers - 1]

        # 边界框偏移量
        all_box_offsets = self.sam3.detr_decoder.box_head(intermediate_hidden)
        ref_boxes_inv_sig = self._inverse_sigmoid(decoder_outputs.reference_boxes)

        if isinstance(all_box_offsets, (tuple, list)):
            stacked_offsets = torch.stack(all_box_offsets, dim=0)
            last_box_offsets = stacked_offsets[self.num_decoder_layers - 1]
        else:
            last_box_offsets = all_box_offsets[self.num_decoder_layers - 1]

        if isinstance(ref_boxes_inv_sig, (tuple, list)):
            stacked_ref = torch.stack(ref_boxes_inv_sig, dim=0)
            last_ref_inv_sig = stacked_ref[self.num_decoder_layers - 1]
        else:
            last_ref_inv_sig = ref_boxes_inv_sig[self.num_decoder_layers - 1]

        pred_boxes_cxcywh = (last_ref_inv_sig + last_box_offsets).sigmoid()
        pred_boxes = self._box_cxcywh_to_xyxy(pred_boxes_cxcywh)

        # 分类分数
        all_pred_logits = self.sam3.dot_product_scoring(
            decoder_hidden_states=intermediate_hidden,
            text_features=encoder_outputs.text_features,
            text_mask=text_mask,
        ).squeeze(-1)

        if isinstance(all_pred_logits, (tuple, list)):
            stacked_logits = torch.stack(all_pred_logits, dim=0)
            pred_logits = stacked_logits[self.num_decoder_layers - 1]
        else:
            pred_logits = all_pred_logits[self.num_decoder_layers - 1]

        # 存在性分数
        presence_logits_all = decoder_outputs.presence_logits
        if isinstance(presence_logits_all, (tuple, list)):
            stacked_presence = torch.stack(presence_logits_all, dim=0)
            presence_logits = stacked_presence[self.num_decoder_layers - 1]
        else:
            presence_logits = presence_logits_all[self.num_decoder_layers - 1]

        # 掩码解码器
        mask_outputs = self.sam3.mask_decoder(
            decoder_queries=last_decoder_hidden,
            backbone_features=list(fpn_hidden_states),
            encoder_hidden_states=encoder_outputs.last_hidden_state,
            prompt_features=text_features,
            prompt_mask=text_mask,
        )

        return (
            mask_outputs.pred_masks,
            pred_logits,
            pred_boxes,
            presence_logits,
            mask_outputs.semantic_seg,
        )

    @staticmethod
    def _inverse_sigmoid(x, eps=1e-5):
        x = x.clamp(min=eps, max=1 - eps)
        return torch.log(x / (1 - x))

    @staticmethod
    def _box_cxcywh_to_xyxy(boxes):
        cx, cy, w, h = boxes.unbind(-1)
        x1 = cx - w / 2
        y1 = cy - h / 2
        x2 = cx + w / 2
        y2 = cy + h / 2
        return torch.stack([x1, y1, x2, y2], dim=-1)


def create_wrapper(model, device):
    wrapper = Sam3FlatBatchONNXWrapper(model).to(device).eval()
    print(f"包装器创建完成（解码器层数: {wrapper.num_decoder_layers}）")
    return wrapper


def verify_forward(wrapper, pixel_values, input_ids, attention_mask):
    print("验证包装器前向传播...")
    with torch.no_grad():
        outputs = wrapper(pixel_values, input_ids, attention_mask)
    print("前向传播成功")
    print(f"输出数量: {len(outputs)}")
    for i, out in enumerate(outputs):
        if out is not None:
            has_nan = torch.isnan(out).any().item()
            print(f"  out[{i}] shape={out.shape}, range=[{out.min():.3f}, {out.max():.3f}], has_nan={has_nan}")
        else:
            print(f"  out[{i}] = None")
    return outputs


def export_onnx(wrapper, sample_inputs, output_path, opset_version):
    pixel_values, input_ids, attention_mask = sample_inputs
    dynamic_axes = {
        "pixel_values": {0: "batch_size"},
        "input_ids": {0: "batch_size"},
        "attention_mask": {0: "batch_size"},
        "pred_masks": {0: "batch_size"},
        "pred_logits": {0: "batch_size"},
        "pred_boxes": {0: "batch_size"},
        "presence_logits": {0: "batch_size"},
        "semantic_seg": {0: "batch_size"},
    }
    print(f"导出 ONNX 到 {output_path} ...")
    torch.onnx.export(
        wrapper,
        (pixel_values, input_ids, attention_mask),
        str(output_path),
        input_names=["pixel_values", "input_ids", "attention_mask"],
        output_names=["pred_masks", "pred_logits", "pred_boxes", "presence_logits", "semantic_seg"],
        dynamic_axes=dynamic_axes,
        opset_version=opset_version,
        do_constant_folding=False,
        verbose=False,
        export_params=True,
        dynamo=False,
        external_data=True,
    )
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"ONNX 模型已导出，文件大小: {size_mb:.2f} MB")
    return size_mb


def validate_onnx_structure(onnx_path):
    try:
        import onnx
        # 直接检查模型文件，不先加载到内存
        onnx.checker.check_model(str(onnx_path))
        print("ONNX 模型结构验证通过")

        # 加载模型元数据（不加载外部数据）用于打印信息
        model = onnx.load(str(onnx_path), load_external_data=False)
        print("\n模型输入:")
        for inp in model.graph.input:
            dims = [d.dim_value if d.dim_value > 0 else d.dim_param or 'dynamic'
                    for d in inp.type.tensor_type.shape.dim]
            print(f"  {inp.name}: {dims}")
        print("\n模型输出:")
        for out in model.graph.output:
            dims = [d.dim_value if d.dim_value > 0 else d.dim_param or 'dynamic'
                    for d in out.type.tensor_type.shape.dim]
            print(f"  {out.name}: {dims}")
        return True
    except Exception as e:
        print(f"ONNX 结构验证失败: {e}")
        return False


def validate_onnx_runtime(onnx_path, sample_inputs, reference_outputs, output_names):
    try:
        import onnxruntime as ort
        import numpy as np
    except ImportError:
        print("未安装 onnxruntime，跳过 Runtime 验证")
        return False

    pixel_values, input_ids, attention_mask = sample_inputs
    session = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])

    feeds = {
        "pixel_values": pixel_values.numpy().astype(np.float32),
        "input_ids": input_ids.numpy().astype(np.int64),
        "attention_mask": attention_mask.numpy().astype(np.int64),
    }
    onnx_outputs = session.run([out.name for out in session.get_outputs()], feeds)
    print("ONNX Runtime 推理成功")

    all_match = True
    for i, (pt_out, onnx_out) in enumerate(zip(reference_outputs, onnx_outputs)):
        pt_np = pt_out.numpy()
        max_diff = np.abs(pt_np - onnx_out).max()
        has_nan_onnx = np.isnan(onnx_out).any()

        if has_nan_onnx:
            print(f"  {output_names[i]}: ONNX 输出包含 NaN")
            all_match = False
        else:
            print(f"  {output_names[i]}: max_diff={max_diff:.6f}, range=[{onnx_out.min():.3f}, {onnx_out.max():.3f}]")
            if max_diff > 0.01:
                print("    warning: 差异大于 0.01")
    return all_match


def main():
    args = parse_args()
    args.target_device = normalize_target_device(args.target_device)
    set_thread_env(args.num_threads)

    print("=" * 60)
    print("SAM3 ONNX 导出（展平输入）")
    print("=" * 60)
    print(f"模型路径: {args.model_path}")
    print(f"图片路径: {args.image_path}")
    print(f"提示词: {args.prompt}")
    print(f"输出目录: {args.output_dir}")
    print(f"输出文件: {args.output_name}")
    print(f"目标设备: {args.target_device}")
    print("动态 batch 导出: 是")
    print(f"导出设备: {args.export_device}")
    print(f"opset: {args.opset_version}")
    print("=" * 60)

    if not os.path.exists(args.model_path):
        raise FileNotFoundError(f"模型路径不存在: {args.model_path}")

    # 1. 加载模型与处理器
    model, processor = load_model_and_processor(
        args.model_path,
        args.export_device,
        args.target_device,
    )

    # 2. 准备示例输入
    sample_inputs = prepare_sample_input(
        processor,
        args.image_path,
        args.prompt,
        args.export_device,
    )

    # 3. 创建包装器
    wrapper = create_wrapper(model, args.export_device)
    reference_outputs = None
    if not args.skip_onnx_validation:
        reference_outputs = verify_forward(wrapper, *sample_inputs)

    # 4. 导出 ONNX
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = output_dir / args.output_name
    try:
        exported_size = export_onnx(
            wrapper,
            sample_inputs,
            onnx_path,
            args.opset_version,
        )
        print(f"ONNX 导出成功，文件大小: {exported_size:.2f} MB")
    except Exception as e:
        print(f"导出 ONNX 失败: {e}")
        sys.exit(1)

    # 5. 可选验证
    if not args.skip_onnx_validation:
        print("\n[ONNX 结构验证]")
        try:
            is_valid = validate_onnx_structure(onnx_path)
            if not is_valid:
                print("警告: ONNX 结构验证未通过")
        except Exception as e:
            print(f"ONNX 结构验证异常: {e}")

        print("\n[ONNX Runtime 推理验证]")
        output_names = ["pred_masks", "pred_logits", "pred_boxes", "presence_logits", "semantic_seg"]
        success = validate_onnx_runtime(onnx_path, sample_inputs, reference_outputs, output_names)
        if success:
            print("\nONNX 模型验证通过")
        else:
            print("\nONNX 模型验证失败")
    else:
        print("\n跳过 ONNX 验证")

    print("\n" + "=" * 60)
    print("导出完成")
    print("=" * 60)


if __name__ == "__main__":
    main()
