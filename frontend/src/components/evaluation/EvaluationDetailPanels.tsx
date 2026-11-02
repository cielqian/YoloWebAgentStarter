import { Collapse, Statistic, Tag as AntdTag, Typography } from "antd";
import type { SampleGroup } from "./evaluationDetailHelpers";
import { formatEvalMetric } from "./evaluationDetailHelpers";

// Community port of upstream EvaluationDetailPanels.tsx; pose and router-specific actions are excluded.

export function EvaluationDetailMetrics({ metrics }: { metrics: Record<string, number> }) {
  return <section className="evaluation-metrics">{Object.entries(metrics).length ? Object.entries(metrics).map(([key, value]) => <Statistic key={key} title={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{key}</Typography.Text>} value={formatEvalMetric(value)} styles={{ content: { fontSize: 17, fontWeight: 650 } }} />) : <Typography.Text type="secondary">暂无指标。</Typography.Text>}</section>;
}

export function EvaluationDetailSummary({ summary }: { summary: { missed_detection: number; false_positive: number; low_confidence: number; imageCount: number } }) {
  return (
    <section className="evaluation-summary">
      {/* 保留 article 结构:测试按 .evaluation-summary article 断言 */}
      <article><span>missed_detection</span><strong>{summary.missed_detection}</strong></article>
      <article><span>false_positive</span><strong>{summary.false_positive}</strong></article>
      <article><span>low_confidence</span><strong>{summary.low_confidence}</strong></article>
      <article><span>images</span><strong>{summary.imageCount}</strong></article>
    </section>
  );
}

type EvaluationArtifactName = "pr_curve" | "box_pr_curve" | "mask_pr_curve" | "confusion_matrix";

export function EvaluationDetailArtifacts({ taskId, prCurvePath, boxPrCurvePath, maskPrCurvePath, confusionMatrixPath, artifactUrl }: { taskId: string; prCurvePath?: string | null; boxPrCurvePath?: string | null; maskPrCurvePath?: string | null; confusionMatrixPath?: string | null; artifactUrl: (taskId: string, name: EvaluationArtifactName) => string }) {
  const hasSplitCurves = Boolean(boxPrCurvePath || maskPrCurvePath);
  return <section className="evaluation-artifacts">{hasSplitCurves ? <><ArtifactCard title="Box PR Curve" url={boxPrCurvePath ? artifactUrl(taskId, "box_pr_curve") : ""} /><ArtifactCard title="Mask PR Curve" url={maskPrCurvePath ? artifactUrl(taskId, "mask_pr_curve") : ""} /></> : <ArtifactCard title="PR Curve" url={prCurvePath ? artifactUrl(taskId, "pr_curve") : ""} />}<ArtifactCard title="Confusion Matrix" url={confusionMatrixPath ? artifactUrl(taskId, "confusion_matrix") : ""} /></section>;
}

export function EvaluationDetailSamples({ groups }: { groups: SampleGroup[] }) {
  return <section className="evaluation-samples"><Typography.Title level={5} style={{ margin: 0 }}>错误样本（{groups.reduce((total, group) => total + group.items.length, 0)}）</Typography.Title>{groups.map((group) => <article key={group.imageKey}><div><AntdTag className={`evaluation-sample-badge is-${group.primaryType}`} style={{ margin: 0 }}>{group.primaryType}</AntdTag><strong>{group.imageFile}</strong></div><p>{group.preview}</p><small>{group.items.length} 条 · classes {group.classIndexes.join(", ") || "-"}{group.bestConfidence != null ? ` · max conf ${group.bestConfidence.toFixed(3)}` : ""}</small></article>)}{!groups.length && <Typography.Text type="secondary">暂无错误样本。</Typography.Text>}</section>;
}

export function EvaluationDetailLogs({ logs }: { logs: string }) {
  return (
    <Collapse
      size="small"
      className="evaluation-logs"
      defaultActiveKey={["logs"]}
      items={[{
        key: "logs",
        label: <Typography.Text strong style={{ fontSize: 12 }}>评估日志</Typography.Text>,
        children: <pre style={{ margin: 0, maxHeight: 240, overflow: "auto", fontSize: 11, lineHeight: 1.55 }}>{logs || "暂无日志。"}</pre>,
      }]}
    />
  );
}

function ArtifactCard({ title, url }: { title: string; url: string }) {
  return <figure><figcaption><Typography.Text strong style={{ fontSize: 12 }}>{title}</Typography.Text></figcaption>{url ? <img src={url} alt={title} /> : <Typography.Text type="secondary">产物将在评估完成后显示。</Typography.Text>}</figure>;
}
