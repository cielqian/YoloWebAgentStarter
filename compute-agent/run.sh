#!/usr/bin/env bash
# 零依赖离线启动：不需要 pip install，只要服务器上有 python3。
#   ./run.sh                          # 0.0.0.0:8010，无鉴权（仅限内网可信环境）
#   TOKEN=xxx PORT=8010 ./run.sh      # 指定共享密钥与端口
#   PYTHON=/opt/venv/bin/python3 ./run.sh   # 指定带 torch/torch_npu 的解释器
set -euo pipefail
cd "$(dirname "$0")"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8010}"
PYTHON="${PYTHON:-python3}"

if [ -n "${TOKEN:-}" ]; then
  exec "$PYTHON" agent.py --host "$HOST" --port "$PORT" --token "$TOKEN"
fi
exec "$PYTHON" agent.py --host "$HOST" --port "$PORT"
