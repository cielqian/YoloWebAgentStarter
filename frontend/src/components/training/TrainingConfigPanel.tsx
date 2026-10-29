import { useEffect, useState, type FormEvent } from "react";
import {
  Button as AntdButton,
  Card,
  Collapse,
  Flex,
  Input as AntdInput,
  InputNumber,
  Progress,
  Radio,
  Segmented,
  Select as AntdSelect,
  Space,
  Tag as AntdTag,
  Tooltip,
  Typography,
} from "antd";
import { api } from "../../api/client";
import type { BaseWeight, Dataset, DatasetVersion, TaskType } from "../../types";
import {
  BATCH_OPTIONS,
  IMG_SIZE_OPTIONS,
  PRESETS,
  modelChoicesFor,
  taskTypeLabel,
  type PresetId,
  type TrainingFormState,
} from "../../training/helpers";

interface Props {
  datasets: Dataset[];
  dataset: Dataset;
  datasetVersions: DatasetVersion[];
  splitCounts: Record<string, number>;
  form: TrainingFormState;
  preset: PresetId | null;
  advancedOpen: boolean;
  summaryBottomBar: string;
  onDatasetChange: (dataset: Dataset) => void;
  onFormChange: (updater: (prev: TrainingFormState) => TrainingFormState) => void;
  onPreset: (preset: PresetId) => void;
  onAdvancedOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onExit?: () => void;
}

const PRESET_COPY: Record<PresetId, { title: string; body: string; meta: string }> = {
  fast: { title: "快速验证", body: "适合冒烟与调通链路", meta: "30 ep · batch 16" },
  balanced: { title: "均衡训练", body: "日常默认推荐", meta: "50 ep · batch 16" },
  high: { title: "高精度", body: "更长收敛与更稳指标", meta: "100 ep · batch 8" },
};

export function TrainingConfigPanel({
  datasets,
  dataset,
  datasetVersions,
  splitCounts,
  form,
  preset,
  advancedOpen,
  summaryBottomBar,
  onDatasetChange,
  onFormChange,
  onPreset,
  onAdvancedOpenChange,
  onSubmit,
  onExit,
}: Props) {
  const setForm = onFormChange;
  const selectedVersion = datasetVersions.find((version) => version.version_number === form.dataset_version_number);
  const [baseWeights, setBaseWeights] = useState<BaseWeight[]>([]);
  useEffect(() => {
    if (typeof api.listWeights === "function") api.listWeights().then((result) => setBaseWeights(result.items)).catch(() => undefined);
  }, []);
  const modelChoices = [
    ...modelChoicesFor(dataset.task_type),
    ...baseWeights.map((weight) => ({ value: weight.name, label: `基础权重库 · ${weight.name}` })),
  ];
  const annotatedPercent = dataset.image_count ? Math.round(dataset.annotated_image_count / dataset.image_count * 100) : 0;

  return (
    <section id="training-config-anchor">
      {onExit && (
        <Flex justify="flex-end" style={{ marginBottom: 12 }}>
          <AntdButton onClick={onExit}>← 返回记录列表</AntdButton>
        </Flex>
      )}

      <form onSubmit={onSubmit}>
        {/* 数据集选择 */}
        <Card size="small" title="数据集" style={{ marginBottom: 16 }}>
          <Flex gap={12} wrap style={{ marginBottom: 12 }}>
            <AntdSelect
              value={dataset.id}
              onChange={(id) => { const next = datasets.find((item) => item.id === id); if (next) onDatasetChange(next); }}
              options={datasets.map((item) => ({
                value: item.id,
                label: `${item.name} · ${taskTypeLabel(item.task_type)} · ${item.image_count} 张`,
              }))}
              style={{ minWidth: 220, flex: 1 }}
            />
            <AntdSelect
              value={form.dataset_version_number ?? undefined}
              placeholder="跟随数据集"
              onChange={(v) => setForm((prev) => ({ ...prev, dataset_version_number: v ?? null }))}
              options={[
                { value: undefined as unknown as string, label: "跟随数据集" },
                ...datasetVersions.map((v) => ({
                  value: v.version_number as unknown as string,
                  label: `${v.version_label || `v${v.version_number}`}${v.is_active ? "（激活）" : ""} · ${v.image_count} 张`,
                })),
              ]}
              style={{ minWidth: 180, flex: 1 }}
            />
          </Flex>
          <Space size={8} wrap>
            <AntdTag>{taskTypeLabel(dataset.task_type)}</AntdTag>
            {selectedVersion ? (
              <>
                <AntdTag color="blue">{selectedVersion.version_label || `v${selectedVersion.version_number}`}</AntdTag>
                <Typography.Text type="secondary">{selectedVersion.image_count} 张 · {selectedVersion.class_count} 类 · {selectedVersion.annotation_count} 条标注</Typography.Text>
              </>
            ) : (
              <>
                <Typography.Text type="secondary">{dataset.image_count} 张 · {dataset.class_count} 类</Typography.Text>
                {dataset.image_count > 0 && <Progress percent={annotatedPercent} size="small" style={{ width: 100 }} />}
              </>
            )}
          </Space>
        </Card>

        {/* 训练预设 */}
        <Card size="small" title="训练预设" style={{ marginBottom: 16 }}>
          <Segmented
            value={preset ?? "balanced"}
            onChange={(v) => onPreset(v as PresetId)}
            options={(["fast", "balanced", "high"] as const).map((id) => ({
              value: id,
              label: (
                <div style={{ padding: "4px 12px", textAlign: "center" }}>
                  <div style={{ fontWeight: 700 }}>{PRESET_COPY[id].title}</div>
                  <div style={{ fontSize: 11, color: "#7d8799" }}>{PRESET_COPY[id].meta}</div>
                </div>
              ),
            }))}
            block
          />
        </Card>

        {/* 模型与基础参数 */}
        <Card size="small" title="模型与基础参数" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            <AntdInput addonBefore="任务名称" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} required />
            <AntdSelect
              value={modelChoices.some((c) => c.value === form.model) ? form.model : undefined}
              placeholder="选择权重"
              showSearch
              onChange={(v) => setForm((prev) => ({ ...prev, model: v }))}
              options={modelChoices}
              style={{ width: "100%" }}
            />
            {!modelChoices.some((c) => c.value === form.model) && form.model && (
              <AntdInput addonBefore="自定义权重" value={form.model} onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))} />
            )}
            <InputNumber addonBefore="Epochs" min={1} value={form.epochs} onChange={(v) => setForm((prev) => ({ ...prev, epochs: v ?? 1 }))} style={{ width: "100%" }} />
            <AntdSelect
              value={form.batch_size as unknown as string}
              onChange={(v) => setForm((prev) => ({ ...prev, batch_size: Number(v) }))}
              options={BATCH_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
              style={{ width: "100%" }}
              placeholder="Batch"
            />
            <AntdSelect
              value={form.img_size as unknown as string}
              onChange={(v) => setForm((prev) => ({ ...prev, img_size: Number(v) }))}
              options={IMG_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n}px` }))}
              style={{ width: "100%" }}
              placeholder="Image size"
            />
            <InputNumber addonBefore="hsv_h" step={0.001} min={0} max={1} value={Number(form.hsv_h) || undefined} placeholder="0.015" onChange={(v) => setForm((prev) => ({ ...prev, hsv_h: v != null ? String(v) : "" }))} style={{ width: "100%" }} />
            <InputNumber addonBefore="旋转" step={1} min={0} max={180} value={Number(form.degrees) || undefined} placeholder="10" onChange={(v) => setForm((prev) => ({ ...prev, degrees: v != null ? String(v) : "" }))} style={{ width: "100%" }} />
            <InputNumber addonBefore="Mixup" step={0.05} min={0} max={1} value={Number(form.mixup) || undefined} placeholder="0.1" onChange={(v) => setForm((prev) => ({ ...prev, mixup: v != null ? String(v) : "" }))} style={{ width: "100%" }} />
            <InputNumber addonBefore="翻转" step={0.05} min={0} max={1} value={Number(form.fliplr) || undefined} placeholder="0" onChange={(v) => setForm((prev) => ({ ...prev, fliplr: v != null ? String(v) : "" }))} style={{ width: "100%" }} />
          </div>
          <Tooltip title="包含时未标注图片以空标签参与训练与验证（YOLO 背景样本）">
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ marginRight: 8, fontSize: 12 }}>未标注图片:</Typography.Text>
              <Radio.Group
                value={form.include_unannotated ? "include" : "skip"}
                onChange={(e) => setForm((prev) => ({ ...prev, include_unannotated: e.target.value === "include" }))}
                optionType="button"
                size="small"
              >
                <Radio.Button value="skip">跳过</Radio.Button>
                <Radio.Button value="include">包含·空标签</Radio.Button>
              </Radio.Group>
            </div>
          </Tooltip>
        </Card>

        {/* 高级参数 */}
        <Collapse
          size="small"
          activeKey={advancedOpen ? ["advanced"] : []}
          onChange={(keys) => onAdvancedOpenChange(keys.includes("advanced"))}
          items={[{
            key: "advanced",
            label: <span><strong>高级参数</strong> <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>优化器、学习率、patience、workers</Typography.Text></span>,
            children: (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
                <InputNumber addonBefore="Val ratio" step={0.05} min={0} max={0.9} value={form.val_ratio} onChange={(v) => setForm((prev) => ({ ...prev, val_ratio: v ?? 0.2 }))} style={{ width: "100%" }} />
                <InputNumber addonBefore="Seed" value={form.seed} onChange={(v) => setForm((prev) => ({ ...prev, seed: v ?? 42 }))} style={{ width: "100%" }} />
                <AntdInput addonBefore="lr0" value={form.lr0} placeholder="默认" onChange={(e) => setForm((prev) => ({ ...prev, lr0: e.target.value }))} />
                <AntdInput addonBefore="Optimizer" value={form.optimizer} placeholder="auto" onChange={(e) => setForm((prev) => ({ ...prev, optimizer: e.target.value }))} />
                <AntdInput addonBefore="Patience" value={form.patience} placeholder={String(PRESETS.balanced.patience)} onChange={(e) => setForm((prev) => ({ ...prev, patience: e.target.value }))} />
                <InputNumber addonBefore="Workers" min={0} value={form.workers} onChange={(v) => setForm((prev) => ({ ...prev, workers: v ?? 2 }))} style={{ width: "100%" }} />
              </div>
            ),
          }]}
          style={{ marginBottom: 16 }}
        />

        <div className="training-config-summary-bar" style={{ padding: "10px 14px", background: "#f5f7fc", borderRadius: 8 }}>
          <span>{summaryBottomBar}</span>
        </div>
      </form>
    </section>
  );
}
