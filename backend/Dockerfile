FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    YWA_HOST=0.0.0.0 \
    YWA_PORT=8000 \
    YWA_DATA_DIR=/app/data \
    YWA_IMPORT_ROOT=/app/data/imports

# ultralytics 会连带安装非 headless 的 opencv-python，需要 libGL；headless 自身需要 libglib2.0。
# 代理环境下纯 HTTP 的 apt 请求会被 502，先切到 https 源。
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/backend/requirements.txt

# 先装 CPU 版 torch：否则 pip 会从 PyPI 拉 CUDA 版及其 nvidia-* 依赖（数 GB）
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app/backend

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
