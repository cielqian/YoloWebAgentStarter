import type { Dataset, TrainingDevice, TrainingNodeStatus } from "../../types";
import {
  agentDeviceId,
  deviceStatusLabel,
  estimateMinutes,
  estimateOptimizerSteps,
  formatGpuMemory,
  taskTypeLabel,
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
  const remoteDevices = devices.filter((item) => item.node_id);
  const remoteSelectedIds = form.node_id && form.node_device ? form.node_device.split(",").filter(Boolean) : [];
  const selectedRemoteDevices = remoteDevices.filter(
    (item) => form.node_id && item.node_id === form.node_id && remoteSelectedIds.includes(agentDeviceId(item)),
  );
  const remoteGpuCount = selectedRemoteDevices.filter((item) => item.type === "cuda" || item.type === "npu").length;
  const gpuCount = Math.max(remoteGpuCount, 1);
  const steps = estimateOptimizerSteps(form.epochs, dataset.image_count, form.batch_size);
  const estMinutes = estimateMinutes(form.epochs, dataset.image_count, form.batch_size, gpuCount);

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

  const resourceText = (() => {
    if (!selectedRemoteDevices.length) return "未选择训练节点";
    const first = selectedRemoteDevices[0];
    const node = first.node_name ?? form.node_id;
    if (selectedRemoteDevices.length > 1) {
      return `${node} · ${selectedRemoteDevices.length} 卡 DDP · ${remoteSelectedIds.join(",")}`;
    }
    const label = DEVICE_TYPE_LABELS[first.type] ?? first.type;
    return `${node} · ${label}${first.index ?? ""}`;
  })();

  return (
    <aside className="training-dataset-rail" aria-label="训练摘要">
      <div className="training-dataset-risk-card">
        <div className="training-dataset-risk-head">
          <IconAlert size={16} />
          <strong>风险提示</strong>
        </div>
        <p>{riskText}</p>
        <p className="training-dataset-risk-hint">训练在所选节点执行：数据集打包上传，完成后产物自动回传管理端。</p>
      </div>

      {nodes.length === 0 && remoteDevices.length === 0 && (
        <div className="training-dataset-compute-card">
          <h3>训练节点算力</h3>
          <p className="muted">尚未注册训练节点。请到「设置 → 训练节点」注册算力服务器后再创建训练任务。</p>
        </div>
      )}

      {(nodes.length > 0 || remoteDevices.length > 0) && (
        <div className="training-dataset-compute-card training-remote-compute-card">
          <h3>训练节点算力</h3>
          <p className="training-dataset-compute-sub">来自已注册的训练节点；同类型加速卡可多选，多卡由 Ultralytics DDP 并行。</p>
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
                  const blocked = device.status === "unavailable";
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
        <p className="training-dataset-summary-lead">{selectedRemoteDevices.length ? "确认后下发到所选节点训练。" : "请先在上方选择训练节点与设备。"}</p>
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
