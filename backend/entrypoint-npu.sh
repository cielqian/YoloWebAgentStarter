#!/bin/sh
set -e

# CANN toolkit 从宿主机挂载进来，加载其环境变量（LD_LIBRARY_PATH 等）
if [ -f /usr/local/Ascend/ascend-toolkit/set_env.sh ]; then
  . /usr/local/Ascend/ascend-toolkit/set_env.sh
else
  echo "[entrypoint-npu] WARN: /usr/local/Ascend/ascend-toolkit/set_env.sh 不存在，未找到宿主机 CANN toolkit" >&2
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
