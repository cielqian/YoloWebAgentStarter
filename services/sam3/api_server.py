import os
import uuid
import glob
import shutil
import subprocess
from PIL import Image, ImageDraw
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse

# ============ 配置 ============
WORK_DIR = "/workspace/sam3_code/SAM3_310P/sam3"
OM_MODEL_PATH = "/workspace/sam3_om/sam3_300I_bs1.om"
PROCESSOR_PATH = "/workspace/sam3_model"
OUTPUT_DIR = "/workspace/output"
INFER_SCRIPT = os.path.join(WORK_DIR, "sam3_single_infer.py")

os.makedirs(OUTPUT_DIR, exist_ok=True)

app = FastAPI(title="SAM3 Segmentation API", version="1.1")


@app.get("/health")
def health():
    return {"status": "ok"}


def parse_box(box_str):
    """解析 'x1,y1,x2,y2'，返回 (x1,y1,x2,y2) 或 None"""
    if not box_str or not box_str.strip():
        return None
    try:
        parts = [int(float(v.strip())) for v in box_str.split(",")]
        if len(parts) != 4:
            raise ValueError
        x1, y1, x2, y2 = parts
        if x2 <= x1 or y2 <= y1:
            raise ValueError
        return x1, y1, x2, y2
    except Exception:
        raise HTTPException(status_code=400, detail="box 格式应为 x1,y1,x2,y2")


@app.post("/segment")
async def segment(
        image: UploadFile = File(...),
        prompt: str = Form(...),
        box: str = Form(""),  # 可选，格式 "x1,y1,x2,y2"
):
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    uid = uuid.uuid4().hex[:8]
    raw_path = os.path.join(OUTPUT_DIR, f"input_{uid}.jpg")
    with open(raw_path, "wb") as f:
        f.write(await image.read())

    # ---- 打开原图 ----
    try:
        orig_img = Image.open(raw_path).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片无法解析: {e}")

    orig_w, orig_h = orig_img.size

    # ---- 解析框，决定推理输入 ----
    crop_box = parse_box(box)
    offset_x, offset_y = 0, 0

    if crop_box:
        x1, y1, x2, y2 = crop_box
        # 边界保护
        x1 = max(0, min(x1, orig_w - 1))
        y1 = max(0, min(y1, orig_h - 1))
        x2 = max(x1 + 1, min(x2, orig_w))
        y2 = max(y1 + 1, min(y2, orig_h))
        offset_x, offset_y = x1, y1

        cropped = orig_img.crop((x1, y1, x2, y2))
        infer_input_path = os.path.join(OUTPUT_DIR, f"crop_{uid}.jpg")
        cropped.save(infer_input_path)
        crop_size = (x2 - x1, y2 - y1)
    else:
        infer_input_path = raw_path
        crop_size = (orig_w, orig_h)

    # ---- 调用推理脚本 ----
    cmd = [
        "python3", INFER_SCRIPT,
        "--model_path", OM_MODEL_PATH,
        "--processor_path", PROCESSOR_PATH,
        "--image", infer_input_path,
        "--prompt", prompt.strip(),
        "--device", "0",
        "--batch_size", "1",
    ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=300, cwd=WORK_DIR,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="推理超时")

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"推理失败: {result.stderr[-1500:]}"
        )

    # ---- 定位推理脚本输出的结果图 ----
    result_path = os.path.join(WORK_DIR, "sam3_result.jpg")
    if not os.path.exists(result_path):
        candidates = sorted(
            glob.glob(os.path.join(WORK_DIR, "*.jpg")) +
            glob.glob(os.path.join(OUTPUT_DIR, "*.jpg")),
            key=os.path.getmtime, reverse=True,
        )
        if not candidates:
            raise HTTPException(status_code=500, detail="未找到结果图")
        result_path = candidates[0]

    # ---- 解析 stdout 里的 score / mask_area / box ----
    score, mask_area, infer_box = None, None, None
    for line in result.stdout.splitlines():
        s = line.strip()
        if "score=" in s and "mask_area=" in s:
            try:
                score = float(s.split("score=")[1].split(",")[0])
                mask_area = s.split("mask_area=")[1].split()[0]
            except Exception:
                pass
        if "box (xyxy):" in s:
            try:
                nums = s.split("box (xyxy):")[1].strip().strip("[]").split(",")
                infer_box = [float(v) for v in nums]
            except Exception:
                pass

    # ---- 坐标还原 + 结果贴回原图 ----
    final_path = os.path.join(OUTPUT_DIR, f"result_{uid}.jpg")

    if crop_box and infer_box:
        # 推理结果是裁剪图坐标系，加偏移还原到原图
        orig_box = [
            infer_box[0] + offset_x,
            infer_box[1] + offset_y,
            infer_box[2] + offset_x,
            infer_box[3] + offset_y,
        ]
    else:
        orig_box = infer_box

    # 把推理结果图缩放/贴回原图对应位置（只有裁剪模式下才需要）
    if crop_box:
        result_img = Image.open(result_path).convert("RGB")
        # 推理脚本输出的可视化图尺寸通常等于输入图尺寸
        if result_img.size != crop_size:
            result_img = result_img.resize(crop_size, Image.BILINEAR)

        # 以原图为底，把裁剪区域的结果图贴回去
        canvas = orig_img.copy()
        canvas.paste(result_img, (offset_x, offset_y))

        # 在原图上画出还原后的框
        if orig_box:
            draw = ImageDraw.Draw(canvas)
            draw.rectangle(orig_box, outline=(255, 0, 0), width=4)

        canvas.save(final_path, "JPEG", quality=95)
    else:
        # 全图模式：直接复制推理结果
        shutil.copy(result_path, final_path)

    # ---- 返回图片 + 关键信息放在响应头 ----
    headers = {
        "X-Offset": f"{offset_x},{offset_y}" if crop_box else "0,0",
        "X-Score": str(score) if score is not None else "",
        "X-Mask-Area": mask_area or "",
        "X-Box": ",".join(f"{v:.1f}" for v in orig_box) if orig_box else "",
    }
    return FileResponse(
        final_path,
        media_type="image/jpeg",
        filename=f"result_{uid}.jpg",
        headers=headers,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)

