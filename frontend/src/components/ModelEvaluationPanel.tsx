import { useEffect, useMemo, useState } from "react";
import { Button as AntdButton, Empty as AntdEmpty, Segmented, Space, Tag as AntdTag, Typography } from "antd";
import { api } from "../api/client";
import type { ModelEvaluationRecord, ModelVersion, SplitName } from "../types";
import { EvaluationDetailArtifacts, EvaluationDetailLogs, EvaluationDetailMetrics, EvaluationDetailSamples, EvaluationDetailSummary } from "./evaluation/EvaluationDetailPanels";
import { groupSamples, summarizeSamples } from "./evaluation/evaluationDetailHelpers";

interface Props {
  model: ModelVersion;
  evaluations: ModelEvaluationRecord[];
  busy: boolean;
  onEvaluate: (split: SplitName) => void;
}

const STATUS_TAG: Record<ModelEvaluationRecord["status"], { color: string; label: string }> = {
  pending: { color: "default", label: "pending" },
  running: { color: "processing", label: "running" },
  completed: { color: "success", label: "completed" },
  failed: { color: "error", label: "failed" },
};

export function ModelEvaluationPanel({ model, evaluations, busy, onEvaluate }: Props) {
  const [split, setSplit] = useState<SplitName>("val");
  const [selectedId, setSelectedId] = useState("");
  const [logs, setLogs] = useState("");
  const selected = useMemo(() => evaluations.find((item) => item.id === selectedId) ?? evaluations[0], [evaluations, selectedId]);

  useEffect(() => {
    if (!selected) { setLogs(""); return; }
    api.modelEvaluationLogs(model.id, selected.id).then((response) => setLogs(response.logs)).catch(() => setLogs(""));
  }, [model.id, selected?.id, selected?.status]);

  const metrics = selected?.result_json.metrics ?? {};
  const artifacts = selected?.result_json.artifacts ?? {};
  const samples = selected?.result_json.error_samples ?? [];
  const summary = summarizeSamples(samples);
  const groups = groupSamples(samples);

  return (
    <section className="evaluation-panel">
      <div className="evaluation-heading">
        <div>
          <Typography.Text type="secondary" className="models-eyebrow">LOCAL EVALUATION</Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>按已保存 split 评估</Typography.Title>
          <Typography.Text type="secondary">后台运行上游同款 YOLO val，并保留指标、图表、日志和可审阅错误样本。</Typography.Text>
        </div>
        <Space>
          <Segmented size="small" value={split} onChange={(value) => setSplit(value as SplitName)} options={[{ value: "val", label: "val" }, { value: "test", label: "test" }, { value: "train", label: "train" }]} />
          <AntdButton size="small" type="primary" disabled={busy} onClick={() => onEvaluate(split)}>创建评估任务</AntdButton>
        </Space>
      </div>
      {!evaluations.length ? <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description="暂无评估任务。" style={{ margin: "18px 0" }} /> : <div className="evaluation-body">
        <div className="evaluation-history">{evaluations.map((item) => (
          <AntdButton key={item.id} type="text" block className={selected?.id === item.id ? "evaluation-task selected" : "evaluation-task"} onClick={() => setSelectedId(item.id)}>
            <strong>{item.split} · {item.created_at.slice(0, 16).replace("T", " ")}</strong>
            <AntdTag color={STATUS_TAG[item.status].color} style={{ margin: 0 }}>{STATUS_TAG[item.status].label}</AntdTag>
          </AntdButton>
        ))}</div>
        {selected && <div className="evaluation-detail">
          <div className="evaluation-status">
            <strong>任务 {selected.status}</strong>
            <Typography.Text type="secondary">conf {selected.confidence} · iou {selected.iou}</Typography.Text>
            {selected.error_message && <Typography.Text type="danger">{selected.error_message}</Typography.Text>}
          </div>
          <EvaluationDetailMetrics metrics={metrics} />
          <EvaluationDetailSummary summary={summary} />
          <EvaluationDetailArtifacts taskId={selected.id} prCurvePath={artifacts.pr_curve} boxPrCurvePath={artifacts.box_pr_curve} maskPrCurvePath={artifacts.mask_pr_curve} confusionMatrixPath={artifacts.confusion_matrix} artifactUrl={(taskId, name) => api.modelEvaluationArtifactUrl(model.id, taskId, name)} />
          <EvaluationDetailSamples groups={groups} />
          <EvaluationDetailLogs logs={logs} />
        </div>}
      </div>}
    </section>
  );
}
