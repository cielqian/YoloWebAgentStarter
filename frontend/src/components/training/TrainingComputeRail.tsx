import type { Dataset, TrainingDevice, TrainingNodeStatus } from "../../types";
import {
  agentDeviceId,
  deviceStatusLabel,
  estimateMinutes,
  estimateOptimizerSteps,
  formatGpuMemory,
  taskTypeLabel,
  type ComputeMode,
  type DeviceType,
  type TrainingFormState,
} from "../../training/helpers";
import { IconAlert, IconClock, IconPlay, IconSave } from "./icons";

interface Props {
  dataset: Dataset;
  form: TrainingFormState;
  devices: TrainingDevice[];
  nodes?: TrainingNodeStatus[];
  busy: boolean;
  canSubmit: boolean;
  riskText: string;
  onFormChange: (updater: (prev: TrainingFormState) => TrainingFormState) => void;
  onSaveDraft: () => void;
}

const DEVICE_TYPE_LABELS: Record<string, string> = { cpu: "CPU", cuda: "CUDA", mps: "MPS", npu: "NPU" };

export function TrainingComputeRail({
  dataset,
  form,
  devices,
  nodes = [],
  busy,
  canSubmit,
  riskText,
  onFormChange,
  onSaveDraft,
}: Props) {
  const setForm = onFormChange;
  const localDevices = devices.filter((item) => !item.node_id);
  const remoteDevices = devices.filter((item) => item.node_id);
  const cudaDevices = localDevices.filter((item) => item.type === "cuda");
  const hasMps = localDevices.some((item) => item.type === "mps" && item.status !== "unavailable");
  const remoteSelectedIds = form.node_id && form.node_device ? form.node_device.split(",").filter(Boolean) : [];
  const selectedRemoteDevices = remoteDevices.filter(
    (item) => form.node_id && item.node_id === form.node_id && remoteSelectedIds.includes(agentDeviceId(item)),
  );
  const remoteGpuCount = selectedRemoteDevices.filter((item) => item.type === "cuda" || item.type === "npu").length;
  const gpuCount = form.node_id
    ? Math.max(remoteGpuCount, 1)
    : form.device_type === "cuda" ? Math.max(form.gpu_ids.length, 1) : 1;
  const totalBatch = form.batch_size * (form.compute_mode === "multi" ? Math.max(form.gpu_ids.length, 1) : 1);
  const steps = estimateOptimizerSteps(form.epochs, dataset.image_count, form.batch_size);
  const estMinutes = estimateMinutes(form.epochs, dataset.image_count, form.batch_size, gpuCount);

  const setDeviceType = (deviceType: DeviceType) => {
    setForm((prev) => {
      const next = { ...prev, device_type: deviceType, node_id: null, node_device: null };
      if (deviceType === "cuda" && !prev.gpu_ids.length) {
        const first = cudaDevices[0];
        next.gpu_ids = first?.index != null ? [String(first.index)] : ["0"];
        next.compute_mode = "single";
      }
      return next;
    });
  };

  const toggleRemoteDevice = (device: TrainingDevice) => {
    const deviceId = agentDeviceId(device);
    setForm((prev) => {
      const current = prev.node_device ? prev.node_device.split(",").filter(Boolean) : [];
      if (prev.node_id === device.node_id && current.includes(deviceId)) {
        const next = current.filter((id) => id !== deviceId);
        return next.length ? { ...prev, node_device: next.join(",") } : { ...prev, node_id: null, node_device: null };
      }
      if (prev.node_id !== device.node_id) {
        return { ...prev, node_id: device.node_id ?? null, node_device: deviceId };
      }
      const sameType = current.every((id) => id.split(":")[0] === deviceId.split(":")[0]);
      return { ...prev, node_device: (sameType ? [...current, deviceId] : [deviceId]).join(",") };
    });
  };

  const setComputeMode = (mode: ComputeMode) => {
    setForm((prev) => {
      if (mode === "single") {
        return { ...prev, compute_mode: "single", gpu_ids: prev.gpu_ids.slice(0, 1) };
      }
      const ids = prev.gpu_ids.length > 1
        ? prev.gpu_ids
        : cudaDevices.slice(0, 2).map((item) => String(item.index ?? 0));
      return { ...prev, compute_mode: "multi", gpu_ids: ids };
    });
  };

  const resourceText = (() => {
    if (selectedRemoteDevices.length) {
      const first = selectedRemoteDevices[0];
      const node = first.node_name ?? form.node_id;
      if (selectedRemoteDevices.length > 1) {
        return `远程 · ${node} · ${selectedRemoteDevices.length} 卡 DDP · ${remoteSelectedIds.join(",")}`;
      }
      const label = DEVICE_TYPE_LABELS[first.type] ?? first.type;
      return `远程 · ${node} · ${label}${first.index ?? ""}`;
    }
    if (form.device_type === "cpu") return "CPU";
    if (form.device_type === "mps") return "Apple MPS";
    if (form.device_type === "auto") return "auto（CUDA → MPS → CPU）";
    if (form.compute_mode === "multi") return `CUDA DDP · ${form.gpu_ids.join(",") || "0,1"}`;
    return `CUDA GPU ${form.gpu_ids[0] ?? "0"}`;
  })();

  return (
    <aside className="training-dataset-rail" aria-label="训练摘要">
      <div className="training-dataset-risk-card">
        <div className="training-dataset-risk-head">
          <IconAlert size={16} />
          <strong>风险提示</strong>
        </div>
        <p>{riskText}</p>
        <p className="training-dataset-risk-hint">
          {selectedRemoteDevices.length
            ? "训练在远程节点执行：数据集将打包上传，完成后产物自动回传本机。"
            : "训练写入本机 data/runs，并可能下载 Ultralytics 权重。"}
        </p>
      </div>

      <div className="training-dataset-compute-card">
        <h3>算力</h3>
        <p className="training-dataset-compute-sub">选择本机设备；多 GPU 将交给 Ultralytics DDP。</p>
        <div className="training-dataset-device-list training-dataset-device-list--grid training-dataset-device-list--quad">
          <button type="button" className={`training-dataset-device-item${!form.node_id && form.device_type === "auto" ? " active" : ""}`} onClick={() => setDeviceType("auto")}>
            <span className="training-dataset-device-name">Auto</span>
            <span className="training-dataset-device-state">智能选择</span>
          </button>
          <button type="button" className={`training-dataset-device-item${!form.node_id && form.device_type === "cpu" ? " active" : ""}`} onClick={() => setDeviceType("cpu")}>
            <span className="training-dataset-device-name">CPU</span>
            <span className="training-dataset-device-state">{deviceStatusLabel(localDevices.find((item) => item.type === "cpu"), "可用")}</span>
          </button>
          <button type="button" className={`training-dataset-device-item${!form.node_id && form.device_type === "mps" ? " active" : ""}`} onClick={() => setDeviceType("mps")} disabled={!hasMps}>
            <span className="training-dataset-device-name">MPS</span>
            <span className="training-dataset-device-state">{hasMps ? deviceStatusLabel(localDevices.find((item) => item.type === "mps"), "可用") : "不可用"}</span>
          </button>
          <button type="button" className={`training-dataset-device-item${!form.node_id && form.device_type === "cuda" ? " active" : ""}`} onClick={() => setDeviceType("cuda")} disabled={!cudaDevices.length}>
            <span className="training-dataset-device-name">CUDA</span>
            <span className="training-dataset-device-state">{cudaDevices.length ? deviceStatusLabel(cudaDevices[0], "可用") : "无 GPU"}</span>
          </button>
        </div>

        {!form.node_id && form.device_type === "cuda" && cudaDevices.length > 0 && (
          <div className="training-dataset-compute-extra">
            <div className="training-config-block-head training-config-block-head--tight">
              <h3>GPU 模式</h3>
            </div>
            <div className="training-config-choice-grid training-config-choice-grid--two">
              <button type="button" className={`training-config-choice-card training-config-choice-card--compact${form.compute_mode === "single" ? " active" : ""}`} onClick={() => setComputeMode("single")}>
                <div className="training-config-choice-top"><strong>单 GPU</strong></div>
              </button>
              <button type="button" className={`training-config-choice-card training-config-choice-card--compact${form.compute_mode === "multi" ? " active" : ""}`} onClick={() => setComputeMode("multi")} disabled={cudaDevices.length < 2}>
                <div className="training-config-choice-top"><strong>多 GPU</strong></div>
              </button>
            </div>

            <div className="training-dataset-gpu-grid">
              {cudaDevices.map((gpu) => {
                const gpuId = String(gpu.index ?? 0);
                const selected = form.gpu_ids.includes(gpuId);
                const busyGpu = gpu.status === "busy";
                return (
                  <button
                    key={gpu.id}
                    type="button"
                    className={`training-dataset-gpu-card${selected ? " active" : ""}${busyGpu ? " disabled" : ""}`}
                    disabled={busyGpu}
                    onClick={() => {
                      if (form.compute_mode === "single") {
                        setForm((prev) => ({ ...prev, gpu_ids: [gpuId] }));
                        return;
                      }
                      setForm((prev) => ({
                        ...prev,
                        gpu_ids: selected ? prev.gpu_ids.filter((id) => id !== gpuId) : [...prev.gpu_ids, gpuId],
                      }));
                    }}
                  >
                    <div className="training-dataset-gpu-top">
                      <strong>GPU {gpuId}</strong>
                      <span className={`training-dataset-gpu-state ${gpu.status === "busy" ? "busy" : "idle"}`}>
                        {deviceStatusLabel(gpu, "空闲")}
                      </span>
                    </div>
                    <span>{gpu.name}</span>
                    <span>{formatGpuMemory(gpu)}</span>
                  </button>
                );
              })}
            </div>
            {form.compute_mode === "multi" && (
              <p className="training-dataset-batch-tip">
                {form.gpu_ids.length || 0} 卡 · 每卡 batch {form.batch_size} · 全局约 {totalBatch}
              </p>
            )}
          </div>
        )}
      </div>

      {(nodes.length > 0 || remoteDevices.length > 0) && (
        <div className="training-dataset-compute-card training-remote-compute-card">
          <h3>远程算力</h3>
          <p className="training-dataset-compute-sub">来自已注册的算力服务器 Agent；同类型加速卡可多选，多卡由 Ultralytics DDP 并行。</p>
          {nodes.filter((node) => node.status === "offline").map((node) => (
            <div key={`offline-${node.id}`} className="training-remote-node-offline">
              <strong>{node.name}</strong>
              <span>{node.url}</span>
              <em>不可达：{node.error ?? "连接失败"}</em>
            </div>
          ))}
          {Object.entries(
            remoteDevices.reduce<Record<string, { name: string; items: TrainingDevice[] }>>((groups, device) => {
              const key = device.node_id ?? "node";
              groups[key] = groups[key] ?? { name: device.node_name ?? key, items: [] };
              groups[key].items.push(device);
              return groups;
            }, {}),
          ).map(([key, group]) => (
            <div key={key} className="training-remote-node-group">
              <div className="training-remote-node-head">
                <strong>{group.name}</strong>
                <span className="status ready">在线 · {group.items.length} 个设备</span>
              </div>
              <div className="training-remote-device-grid">
                {group.items.map((device) => {
                  const selected = form.node_id === device.node_id && remoteSelectedIds.includes(agentDeviceId(device));
                  const blocked = device.status === "busy" || device.status === "unavailable";
                  return (
                    <button
                      key={device.id}
                      type="button"
                      className={`training-remote-device-card${selected ? " active" : ""}`}
                      disabled={blocked}
                      onClick={() => toggleRemoteDevice(device)}
                    >
                      <div className="training-remote-device-top">
                        <strong>{DEVICE_TYPE_LABELS[device.type] ?? device.type}{device.index != null ? ` ${device.index}` : ""}</strong>
                        <span>{deviceStatusLabel(device, "未知")}</span>
                      </div>
                      <span>{device.name}</span>
                      {(device.type === "cuda" || device.type === "npu") && <span>{formatGpuMemory(device)}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {selectedRemoteDevices.length > 1 && (
            <p className="training-dataset-batch-tip">
              {selectedRemoteDevices.length} 卡 DDP · 每卡 batch {form.batch_size} · 全局约 {form.batch_size * selectedRemoteDevices.length}
            </p>
          )}
        </div>
      )}

      <div className="training-dataset-summary-card">
        <h3>运行摘要</h3>
        <p className="training-dataset-summary-lead">{selectedRemoteDevices.length ? "确认后下发到远程节点训练。" : "确认后创建本地训练任务。"}</p>
        <dl className="training-dataset-summary-dl">
          <div>
            <dt>架构</dt>
            <dd>{form.model} · {taskTypeLabel(dataset.task_type)}</dd>
          </div>
          <div>
            <dt>配置</dt>
            <dd>{form.epochs} ep · batch {form.batch_size} · {form.img_size}px</dd>
          </div>
          <div>
            <dt>设备</dt>
            <dd>{resourceText}</dd>
          </div>
          <div>
            <dt>预估步数</dt>
            <dd>约 {steps.toLocaleString()} iter</dd>
          </div>
          <div>
            <dt>预估时长</dt>
            <dd className="training-dataset-est-row">
              <IconClock size={14} /> 约 {estMinutes} 分钟
            </dd>
          </div>
        </dl>
        <div className="training-dataset-summary-actions">
          <button type="submit" form="dataset-training-ws-form" className="training-dataset-summary-primary" disabled={busy || !canSubmit}>
            <IconPlay size={16} /> 开始训练
          </button>
          <button type="button" className="training-dataset-summary-secondary" onClick={onSaveDraft}>
            <IconSave size={16} /> 保存草稿
          </button>
        </div>
      </div>

      <div className="training-dataset-preview-card training-dataset-preview-card--static">
        <div className="training-dataset-preview-gradient" aria-hidden />
        <div className="training-dataset-preview-text">
          <span className="training-dataset-preview-label">当前数据集</span>
          <strong>{dataset.name}</strong>
          <span className="training-dataset-preview-link">{dataset.image_count} 张 · {dataset.class_count} 类 · {taskTypeLabel(dataset.task_type)}</span>
        </div>
      </div>
    </aside>
  );
}
