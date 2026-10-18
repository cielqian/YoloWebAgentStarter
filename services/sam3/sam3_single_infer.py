#!/usr/bin/env python3
"""SAM3 OM 单图文本 prompt 推理验证（300I 路线）。

复用 sam3_coco_iou_eval.py 的推理与后处理逻辑，对单张图片做
文本 prompt 分割，打印检测分数并保存可视化结果。
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw
import torch
from ais_bench.infer.interface import InferSession
from transformers.models.sam3 import Sam3Processor

SEQ_LEN = 32
MASK_SIZE = 288
NUM_QUERIES = 200


def parse_args():
    parser = argparse.ArgumentParser(description="SAM3 OM single image inference")
    parser.add_argument("--model_path", required=True, help="OM model path")
    parser.add_argument("--processor_path", required=True, help="processor/model directory")
    parser.add_argument("--image", default="./truck.jpg", help="input image")
    parser.add_argument("--prompt", default="truck", help="text prompt")
    parser.add_argument("--device", type=int, default=0, help="NPU device id")
    parser.add_argument("--batch_size", type=int, default=1, help="static OM batch size")
    parser.add_argument("--score_threshold", type=float, default=0.5)
    parser.add_argument("--mask_threshold", type=float, default=0.5)
    parser.add_argument("--output", default="./sam3_result.jpg", help="visualization output")
    return parser.parse_args()


class ModelOutputs:
    def __init__(self, pred_masks, pred_logits, pred_boxes, presence_logits, semantic_seg):
        self.pred_masks = pred_masks
        self.pred_logits = pred_logits
        self.pred_boxes = pred_boxes
        self.presence_logits = presence_logits
        self.semantic_seg = semantic_seg


def main():
    args = parse_args()

    image = Image.open(args.image).convert("RGB")
    width, height = image.size
    print(f"image: {args.image} ({width}x{height}), prompt: '{args.prompt}'")

    processor = Sam3Processor.from_pretrained(args.processor_path, local_files_only=True)
    pixel_values = processor.image_processor([image], return_tensors="pt")["pixel_values"][0]
    tokenized = processor.tokenizer(
        [args.prompt],
        return_tensors="pt",
        truncation=True,
        padding="max_length",
        max_length=SEQ_LEN,
    )
    input_ids = tokenized["input_ids"][0]
    attention_mask = tokenized["attention_mask"][0]
    print(f"pixel_values: {tuple(pixel_values.shape)}, input_ids: {tuple(input_ids.shape)}")

    # 静态 batch，不足部分用首样本补齐
    bs = args.batch_size
    pixel_values = pixel_values.unsqueeze(0).repeat(bs, 1, 1, 1)
    input_ids = input_ids.unsqueeze(0).repeat(bs, 1)
    attention_mask = attention_mask.unsqueeze(0).repeat(bs, 1)

    print(f"loading OM: {args.model_path}")
    session = InferSession(args.device, args.model_path)

    outputs = session.infer(
        [
            np.ascontiguousarray(pixel_values.numpy(), dtype=np.float32),
            np.ascontiguousarray(input_ids.numpy(), dtype=np.int64),
            np.ascontiguousarray(attention_mask.numpy(), dtype=np.int64),
        ]
    )

    def to_tensor(idx, shape):
        return torch.from_numpy(np.asarray(outputs[idx]).reshape(shape))[:1]

    outputs_obj = ModelOutputs(
        to_tensor(0, (bs, NUM_QUERIES, MASK_SIZE, MASK_SIZE)),
        to_tensor(1, (bs, NUM_QUERIES)),
        to_tensor(2, (bs, NUM_QUERIES, 4)),
        to_tensor(3, (bs, 1)),
        to_tensor(4, (bs, 1, MASK_SIZE, MASK_SIZE)),
    )
    for name, tensor in [
        ("pred_masks", outputs_obj.pred_masks),
        ("pred_logits", outputs_obj.pred_logits),
        ("pred_boxes", outputs_obj.pred_boxes),
        ("presence_logits", outputs_obj.presence_logits),
        ("semantic_seg", outputs_obj.semantic_seg),
    ]:
        print(f"  {name}: shape={tuple(tensor.shape)}, "
              f"range=[{tensor.min():.3f}, {tensor.max():.3f}], nan={torch.isnan(tensor).any().item()}")

    results = processor.post_process_instance_segmentation(
        outputs_obj,
        threshold=args.score_threshold,
        mask_threshold=args.mask_threshold,
        target_sizes=[[height, width]],
    )[0]

    masks = results["masks"]
    scores = results["scores"]
    boxes = results.get("boxes", None)
    print(f"\npost-processed instances above score {args.score_threshold}: {len(masks)}")
    for i, (mask, score) in enumerate(zip(masks, scores)):
        area_ratio = mask.float().mean().item()
        print(f"  instance {i}: score={score:.4f}, mask_area={area_ratio * 100:.1f}% of image")
        if boxes is not None and i < 3:
            print(f"    box (xyxy): {[round(v, 1) for v in boxes[i].tolist()]}")

    # 可视化：红色半透明覆盖 + 白色描边 + 黄色检测框
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    if len(masks) > 0:
        combined = np.zeros((height, width), dtype=np.uint8)
        for mask in masks:
            combined |= mask.numpy().astype(np.uint8)
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[combined > 0] = [255, 0, 0, 110]
        overlay = Image.alpha_composite(overlay, Image.fromarray(rgba))

        # 边界：与左右/上下邻居取值不同处即为轮廓
        boundary = np.zeros_like(combined)
        boundary[:, 1:] |= combined[:, 1:] != combined[:, :-1]
        boundary[:, :-1] |= combined[:, 1:] != combined[:, :-1]
        boundary[1:, :] |= combined[1:, :] != combined[:-1, :]
        boundary[:-1, :] |= combined[1:, :] != combined[:-1, :]
        boundary &= combined
        white = np.zeros((height, width, 4), dtype=np.uint8)
        white[boundary > 0] = [255, 255, 255, 255]
        overlay = Image.alpha_composite(overlay, Image.fromarray(white))

    draw = ImageDraw.Draw(overlay)
    if boxes is not None:
        for box in boxes:
            draw.rectangle([box[0], box[1], box[2], box[3]], outline=(255, 255, 0, 255), width=3)
    draw.text((10, 10), f"prompt: '{args.prompt}'  instances: {len(masks)}", fill=(255, 255, 255, 255))

    vis = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    vis.save(args.output)
    print(f"\nvisualization saved: {args.output}")

    session.free_resource()
    if hasattr(InferSession, "finalize"):
        InferSession.finalize()


if __name__ == "__main__":
    main()
