import gradio as gr
import subprocess
import os
import uuid
import glob

# 根据你的实际路径调整
OM_MODEL_PATH = "/workspace/sam3_om/sam3_300I_bs1.om"
PROCESSOR_PATH = "/workspace/sam3_model"
WORK_DIR = "/workspace/sam3_code/SAM3_310P/sam3"

def run_inference(image, prompt):
    if image is None:
        return None, "请先上传图片"
    if not prompt or not prompt.strip():
        return None, "请输入英文提示词（如 truck）"

    # 保存上传的图片到临时路径
    tmp_input = os.path.join(WORK_DIR, f"tmp_{uuid.uuid4().hex[:8]}.jpg")
    image.save(tmp_input)

    # 输出目录
    output_dir = "/workspace/output"
    os.makedirs(output_dir, exist_ok=True)

    # 调用 sam3_single_infer.py
    cmd = [
        "python3", os.path.join(WORK_DIR, "sam3_single_infer.py"),
        "--model_path", OM_MODEL_PATH,
        "--processor_path", PROCESSOR_PATH,
        "--image", tmp_input,
        "--prompt", prompt.strip(),
        "--device", "0",
        "--batch_size", "1",
    ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300, cwd=WORK_DIR
        )
        if result.returncode != 0:
            return None, f"推理失败:\n{result.stderr[-1500:]}"
    except subprocess.TimeoutExpired:
        return None, "推理超时（超过 300 秒）"

    # 查找最新的输出图片（根据 sam3_single_infer.py 的实际输出命名调整）
    candidates = sorted(
        glob.glob(os.path.join(output_dir, "*.jpg")) +
        glob.glob(os.path.join(WORK_DIR, "*.jpg")),
        key=os.path.getmtime, reverse=True
    )
    if not candidates:
        return None, "推理完成但未找到输出图片，请检查脚本输出位置"

    return candidates[0], "推理成功"

with gr.Blocks(title="SAM3 文本引导分割 (Ascend 310P)") as demo:
    gr.Markdown("## SAM3 文本提示分割\n上传图片，输入英文提示词（如 truck, person, dog），点击分割。")
    with gr.Row():
        with gr.Column():
            inp_image = gr.Image(type="pil", label="上传图片")
            inp_prompt = gr.Textbox(label="英文提示词", placeholder="例如: truck")
            btn = gr.Button("开始分割", variant="primary")
        with gr.Column():
            out_image = gr.Image(label="分割结果")
            out_status = gr.Textbox(label="状态")

    btn.click(fn=run_inference, inputs=[inp_image, inp_prompt], outputs=[out_image, out_status])

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860, share=False)
