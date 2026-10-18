#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}"

TARGET_DEVICE="${TARGET_DEVICE:-300I}"
TARGET_DEVICE="${TARGET_DEVICE^^}"
BATCH_SIZE="${BATCH_SIZE:-1}"
ONNX_PATH="./sam3_onnx_${TARGET_DEVICE}/sam3.onnx"
OPT_DIR="./sam3_onnx_optimized_${TARGET_DEVICE}_bs${BATCH_SIZE}"
OPTIMIZED_ONNX="${OPT_DIR}/optimized_onnx.onnx"
OM_NAME="sam3_${TARGET_DEVICE}_bs${BATCH_SIZE}"
ATC_LOG="atc_build.log"
ATC_EXTRA_ARGS=()

if [[ -z "${SOC_VERSION:-}" ]]; then
    echo "SOC_VERSION is required. Check chip name with npu-smi info, for example Ascend310P3 or Ascend910B4." >&2
    exit 1
fi

if [[ "${TARGET_DEVICE}" != "300I" ]]; then
    ATC_EXTRA_ARGS=(--input_format=NCHW --fusion_switch_file=./fusion_switch.cfg)
fi

if ! command -v atc >/dev/null 2>&1; then
    echo "atc command not found. Source the CANN environment before running this script:" >&2
    echo "  source /usr/local/Ascend/ascend-toolkit/set_env.sh" >&2
    exit 1
fi

mkdir -p ./sam3_om

python3 sam3_optimize_onnx.py \
    --model "${ONNX_PATH}" \
    --output-dir "${OPT_DIR}" \
    --probe-shape-profile "pixel_values:1,3,1008,1008;input_ids:1,32;attention_mask:1,32" \
    --probe-shape-profile "pixel_values:${BATCH_SIZE},3,1008,1008;input_ids:${BATCH_SIZE},32;attention_mask:${BATCH_SIZE},32"

if [[ "${TARGET_DEVICE}" == "300I" ]]; then
    flash_tmp="${OPT_DIR}/optimized_onnx.flash_tmp.onnx"
    python3 sam3_flashattentiontik_onnx.py \
        --model "${OPTIMIZED_ONNX}" \
        --output "${flash_tmp}" \
        --batch-size "${BATCH_SIZE}" \
        --expected-count 44
    mv "${flash_tmp}" "${OPTIMIZED_ONNX}"

    mindiesd_location=$(python3 -m pip show mindiesd 2>/dev/null | awk -F': ' '/^Location/ {print $2}' || true)
    if [[ -z "${mindiesd_location}" ]]; then
        echo "mindiesd package is required for FlashAttentionTik custom OPP" >&2
        exit 1
    fi
    mindiesd_dir="${mindiesd_location}/mindiesd"
    export ASCEND_CUSTOM_OPP_PATH="${mindiesd_dir}/ops/vendors/aie_ascendc:${mindiesd_dir}/ops/vendors/customize:${ASCEND_CUSTOM_OPP_PATH:-}"
fi

atc \
    --framework=5 \
    --model="${OPTIMIZED_ONNX}" \
    --output="./sam3_om/${OM_NAME}" \
    --input_shape="pixel_values:${BATCH_SIZE},3,1008,1008;input_ids:${BATCH_SIZE},32;attention_mask:${BATCH_SIZE},32" \
    --soc_version="${SOC_VERSION}" \
    "${ATC_EXTRA_ARGS[@]}"

echo "OM conversion finished: ./sam3_om/${OM_NAME}*.om"
