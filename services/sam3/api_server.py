import os
import uuid
import glob
import subprocess
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse

# ============ 配置 ============
WORK_DIR = "/workspace/sam3_code/SAM3_310P/sam3"
OM_MODEL_PATH = "/workspace/sam3_om/sam3_300I_bs1.om"
PROCESSOR_PATH = "/workspace/sam3_model"
OUTPUT_DIR = "/workspace/output"
INFER_SCRIPT = os.path.join(WORK_DIR, "sam3_single_infer.py")

os.makedirs(OUTPUT_DIR, exist_ok=True)

app = FastAPI(title="SAM3 Segmentation API", version="1.0")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/segment")
async def segment(
    image: UploadFile = File(...),
    prompt: str = Form(...),
):
    # 1. 保存上传的图片
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    uid = uuid.uuid4().hex[:8]
    input_path = os.path.join(OUTPUT_DIR, f"input_{uid}.jpg")
    with open(input_path, "wb") as f:
        f.write(await image.read())

    # 2. 调用推理脚本
    cmd = [
        "python3", INFER_SCRIPT,
        "--model_path", OM_MODEL_PATH,
        "--processor_path", PROCESSOR_PATH,
        "--image", input_path,
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

    # 3. 找结果图（sam3_single_infer.py 输出固定是 sam3_result.jpg）
    result_path = os.path.join(WORK_DIR, "sam3_result.jpg")
    if not os.path.exists(result_path):
        # 兜底：扫最近的 jpg
        candidates = sorted(
            glob.glob(os.path.join(WORK_DIR, "*.jpg")) +
            glob.glob(os.path.join(OUTPUT_DIR, "*.jpg")),
            key=os.path.getmtime, reverse=True,
        )
        if not candidates:
            raise HTTPException(status_code=500, detail="未找到结果图")
        result_path = candidates[0]

    # 4. 复制到输出目录（避免并发覆盖）
    final_path = os.path.join(OUTPUT_DIR, f"result_{uid}.jpg")
    import shutil
    shutil.copy(result_path, final_path)

    # 5. 从 stdout 解析关键指标（可选）
    metrics = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if "score=" in line:
            try:
                metrics["score"] = float(line.split("score=")[1].split(",")[0])
            except Exception:
                pass
        if "mask_area=" in line:
            try:
                metrics["mask_area"] = line.split("mask_area=")[1].split()[0]
            except Exception:
                pass

    return FileResponse(
        final_path,
        media_type="image/jpeg",
        filename=f"result_{uid}.jpg",
        headers={
            "X-Score": str(metrics.get("score", "")),
            "X-Mask-Area": metrics.get("mask_area", ""),
        },
    )
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
