#!/usr/bin/env bash
# YWA Compute Agent 安装脚本：把 agent.py 注册为 systemd 服务常驻运行。
#
# 用法（root 执行）：
#   sudo ./install.sh                          # 交互式询问 conda 环境名
#   sudo ./install.sh -e yolo                  # 指定 conda 环境名
#   sudo ./install.sh -e yolo -p 8010 -t 密钥  # 指定端口与共享密钥
#   sudo ./install.sh -P /usr/bin/python3      # 直接指定解释器(OM/ATC 节点无需 conda)
#   sudo ./install.sh --uninstall              # 停止并卸载服务
#
# 离线可用：只用 bash / systemd / curl，不访问网络。

set -euo pipefail

SERVICE_NAME="ywa-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/ywa-agent.env"
AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONDA_ENV="${CONDA_ENV:-}"
PORT="${PORT:-8010}"
HOST_BIND="${HOST_BIND:-0.0.0.0}"
TOKEN="${YWA_AGENT_TOKEN:-}"

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -e|--env) CONDA_ENV="$2"; shift 2 ;;
    -P|--python) PYTHON_OVERRIDE="$2"; shift 2 ;;
    -p|--port) PORT="$2"; shift 2 ;;
    -t|--token) TOKEN="$2"; shift 2 ;;
    -H|--host) HOST_BIND="$2"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1"; usage ;;
  esac
done
ACTION="${ACTION:-install}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root（sudo）执行本脚本：它需要写入 /etc/systemd/system。" >&2
  exit 1
fi

uninstall() {
  echo "==> 停止并卸载 ${SERVICE_NAME} ..."
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}" "${ENV_FILE}"
  systemctl daemon-reload
  echo "已卸载。agent-workspace 任务数据保留在 ${AGENT_DIR}/agent-workspace，可手动清理。"
}

find_conda_base() {
  if [ -n "${CONDA_BASE:-}" ] && [ -x "${CONDA_BASE}/bin/conda" ]; then
    echo "${CONDA_BASE}"
    return 0
  fi
  if command -v conda >/dev/null 2>&1; then
    conda info --base 2>/dev/null && return 0
  fi
  for candidate in /opt/conda /opt/miniconda3 /opt/anaconda3 \
                   /root/miniconda3 /root/anaconda3 \
                   /usr/local/miniconda3 /usr/local/anaconda3; do
    if [ -x "${candidate}/bin/conda" ] || [ -d "${candidate}/envs" ]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

if [ "${ACTION}" = "uninstall" ]; then
  uninstall
  exit 0
fi

# ---------------- 定位解释器 ----------------

if [ ! -f "${AGENT_DIR}/agent.py" ]; then
  echo "未找到 ${AGENT_DIR}/agent.py，请把整个 compute-agent 目录拷到服务器后再运行。" >&2
  exit 1
fi

PYTHON_BIN=""
if [ -n "${PYTHON_OVERRIDE:-}" ]; then
  PYTHON_BIN="${PYTHON_OVERRIDE}"
  if [ ! -x "${PYTHON_BIN}" ]; then
    echo "指定的解释器不存在或不可执行：${PYTHON_BIN}" >&2
    exit 1
  fi
  echo "==> 解释器:     ${PYTHON_BIN}（手动指定）"
else
  if [ -z "${CONDA_ENV}" ]; then
    read -r -p "请输入运行 agent 的 conda 环境名（如 yolo，留空使用系统 python3）: " CONDA_ENV
  fi
  if [ -z "${CONDA_ENV}" ]; then
    SYSTEM_PYTHON="$(command -v python3 || true)"
    if [ -z "${SYSTEM_PYTHON}" ]; then
      echo "未找到 conda 环境，也没有可用的系统 python3。" >&2
      exit 1
    fi
    PYTHON_BIN="${SYSTEM_PYTHON}"
    echo "==> 未指定 conda 环境，使用系统解释器: ${PYTHON_BIN}"
  else
    if ! CONDA_BASE_PATH="$(find_conda_base)"; then
      echo "未找到 conda 安装目录。可用 -P 指定解释器，或用环境变量指定 conda：" >&2
      echo "  sudo CONDA_BASE=/path/to/conda $0 -e ${CONDA_ENV}" >&2
      echo "  sudo $0 -P /usr/bin/python3" >&2
      exit 1
    fi
    PYTHON_BIN="${CONDA_BASE_PATH}/envs/${CONDA_ENV}/bin/python"
    if [ ! -x "${PYTHON_BIN}" ]; then
      echo "未找到解释器 ${PYTHON_BIN}。" >&2
      echo "请确认环境名正确，或指定 conda 目录：sudo CONDA_BASE=/path/to/conda $0 -e ${CONDA_ENV}" >&2
      exit 1
    fi
    echo "==> conda 目录: ${CONDA_BASE_PATH}"
    echo "==> 解释器:     ${PYTHON_BIN}"
  fi
fi

if ! "${PYTHON_BIN}" -c "pass" >/dev/null 2>&1; then
  echo "==> 解释器无法执行（glibc/架构/权限问题？）：" >&2
  "${PYTHON_BIN}" -V >&2 || true
  exit 1
fi

if "${PYTHON_BIN}" -c "import torch" >/dev/null 2>&1; then
  echo "==> torch 可用，将上报 CUDA / NPU 设备"
else
  echo "==> 警告：该环境没有 torch，agent 只会上报 CPU（服务仍可运行）。" >&2
fi

# ---------------- 生成配置 ----------------

if [ -z "${TOKEN}" ]; then
  TOKEN="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || echo "change-me")"
fi

cat > "${ENV_FILE}" <<EOF
YWA_AGENT_TOKEN=${TOKEN}
EOF
chmod 600 "${ENV_FILE}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=YWA Compute Agent${CONDA_ENV:+ (conda env: ${CONDA_ENV})}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${AGENT_DIR}
EnvironmentFile=${ENV_FILE}
Environment=PYTHONUNBUFFERED=1
Environment="HOME=/root"
# 多卡训练挂起(NCCL P2P 不兼容)时取消下一行注释
# Environment="NCCL_P2P_DISABLE=1"
ExecStart=${PYTHON_BIN} ${AGENT_DIR}/agent.py --host ${HOST_BIND} --port ${PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ---------------- 启动与检查 ----------------

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "==> 服务已启动，等待健康检查 ..."
sleep 2
for _ in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo ""
    echo "安装完成。"
    echo "  服务状态: systemctl status ${SERVICE_NAME}"
    echo "  实时日志: journalctl -u ${SERVICE_NAME} -f"
    echo "  设备巡检: curl http://127.0.0.1:${PORT}/devices"
    echo "  共享密钥（注册训练节点时填入）: ${TOKEN}"
    exit 0
  fi
  sleep 1
done

echo "健康检查未通过，查看日志排查：" >&2
journalctl -u "${SERVICE_NAME}" -n 30 --no-pager >&2 || true
exit 1
