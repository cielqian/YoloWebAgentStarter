import {
  Alert,
  Button as AntdButton,
  Card,
  Collapse,
  Flex,
  Progress,
  Space,
  Statistic,
  Tag as AntdTag,
  Typography,
} from "antd";
import type { TrainingSummary, TrainingTask } from "../../types";
import { api } from "../../api/client";
import { formatDateTime, metricNumber, statusLabel } from "../../training/helpers";

const STATUS_COLOR: Record<string, string> = {
  pending: "default", dispatching: "processing", running: "processing",
  completed: "success", failed: "error", stopped: "warning",
};

interface Props {
  task: TrainingTask;
  summary?: TrainingSummary;
  logs?: string;
  busy: boolean;
  onClose: () => void;
  onStop: () => void;
  onResume: () => void;
}

export function TrainingTaskDetailCard({ task, summary, logs, busy, onClose, onStop, onResume }: Props) {
  const history = summary?.metrics.history ?? [];
  const lossSeries = [
    { key: "train_loss", label: "Loss", color: "#3157d5" },
    { key: "train_box_loss", label: "Box", color: "#3157d5" },
    { key: "train_cls_loss", label: "Cls", color: "#ef8d3c" },
    { key: "train_dfl_loss", label: "DFL", color: "#2a9d8f" },
    { key: "train_seg_loss", label: "Seg", color: "#9b5de5" },
  ].filter((series) => history.some((point) => typeof point[series.key] === "number"));
  const mapSeries = [{ key: "map50", label: "mAP50", color: "#3157d5" }];
  const value = (key: string) => {
    const fromSummary = metricNumber(summary?.metrics[key]);
    if (fromSummary !== undefined) return fromSummary.toFixed(3);
    const fromTask = metricNumber(task.metrics_json[key]);
    return fromTask !== undefined ? fromTask.toFixed(3) : "—";
  };

  const canStop = ["running", "pending", "dispatching"].includes(task.status);
  const canResume = !canStop && !!task.last_model_path;
  const currentLoss = metricNumber(summary?.metrics.loss) ?? metricNumber(task.metrics_json.loss);
  const timing = summary?.timing ?? {};

  return (
    <section id="training-task-detail">
      <Card size="small">
        <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
          <Space size={12}>
            <strong style={{ fontSize: 15 }}>{task.name}</strong>
            <AntdTag color={STATUS_COLOR[task.status] ?? "default"}>{statusLabel(task.status)}</AntdTag>
            <Typography.Text type="secondary">
              {task.progress_epoch}/{task.progress_total_epochs || task.epochs} ep · {task.progress_percent}% · {formatDateTime(task.created_at)}
            </Typography.Text>
          </Space>
          <Space size={8}>
            {canStop ? (
              <AntdButton danger disabled={busy} onClick={onStop}>停止训练</AntdButton>
            ) : (
              <>
                <AntdButton type="primary" disabled={busy || !canResume} onClick={onResume}>
                  {task.status === "completed" ? "从 last.pt 继续" : "恢复中断训练"}
                </AntdButton>
                {task.best_model_path && <AntdButton href={api.downloadCheckpointUrl(task.id, "best")}>best.pt</AntdButton>}
                {task.last_model_path && <AntdButton href={api.downloadCheckpointUrl(task.id, "last")}>last.pt</AntdButton>}
              </>
            )}
            <AntdButton href={api.downloadTrainingLogsUrl(task.id)}>下载日志</AntdButton>
            <AntdButton onClick={onClose}>收起</AntdButton>
          </Space>
        </Flex>

        {task.error_message && (
          <Alert type="error" title={task.error_message} showIcon style={{ marginBottom: 12 }} />
        )}

        {/* 指标条 */}
        <Flex gap={24} wrap style={{ marginBottom: 12 }}>
          <Statistic title="mAP50" value={value("map50")} styles={{ content: { fontSize: 20, fontWeight: 700 } }} />
          <Statistic title="mAP50-95" value={value("map50_95")} styles={{ content: { fontSize: 20, fontWeight: 700 } }} />
          <Statistic title="Precision" value={value("precision")} styles={{ content: { fontSize: 20, fontWeight: 700 } }} />
          <Statistic title="Recall" value={value("recall")} styles={{ content: { fontSize: 20, fontWeight: 700 } }} />
          <Statistic title="Loss" value={formatNumber(currentLoss)} styles={{ content: { fontSize: 20, fontWeight: 700 } }} />
        </Flex>

        {/* 训练进度 */}
        <Progress
          percent={task.progress_percent}
          size="small"
          style={{ marginBottom: 12 }}
          format={() => `${task.progress_epoch}/${task.progress_total_epochs || task.epochs} ep`}
        />

        {/* 耗时信息 */}
        <Space size={16} wrap style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">批次 {formatSeconds(timing.batch_time_seconds)}</Typography.Text>
          <Typography.Text type="secondary">Epoch {formatSeconds(timing.epoch_time_seconds)}</Typography.Text>
          <Typography.Text type="secondary">总耗时 {formatSeconds(timing.elapsed_seconds)}</Typography.Text>
          <Typography.Text type="secondary">{timing.speed_it_per_sec ? `${timing.speed_it_per_sec.toFixed(2)} it/s` : ""}</Typography.Text>
        </Space>

        {/* 图表 */}
        {history.length > 1 && lossSeries.length > 0 && (
          <MetricChart title="Loss 曲线" count={history.length} history={history} series={lossSeries} />
        )}
        {history.length > 1 && history.some((p) => typeof p.map50 === "number") && (
          <MetricChart title="mAP50 趋势" count={history.length} history={history} series={mapSeries} max={1} />
        )}

        {/* 配置快照 */}
        <Collapse
          size="small"
          items={[{
            key: "config",
            label: <strong>训练配置快照</strong>,
            children: (
              <pre style={{ maxHeight: 240, overflow: "auto", fontSize: 11, margin: 0 }}>
                {JSON.stringify(summary?.training_config ?? {
                  model: task.model_name, epochs: task.epochs, img_size: task.img_size,
                  batch_size: task.batch_size, device: task.device, workers: task.workers,
                  optimizer: task.optimizer, lr0: task.lr0, patience: task.patience,
                }, null, 2)}
              </pre>
            ),
          }]}
          style={{ marginBottom: 12 }}
        />

        {/* 日志 */}
        <div style={{ maxHeight: 400, overflow: "auto", padding: 12, border: "1px solid #e7eaf0", borderRadius: 8, background: "#f8f9fc", fontFamily: "ui-monospace, monospace", fontSize: 11, whiteSpace: "pre-wrap" }}>
          {logs || "等待训练日志…"}
        </div>
      </Card>
    </section>
  );
}

function MetricChart({
  title, count, history, series, max: fixedMax,
}: {
  title: string; count: number; history: Array<Record<string, number>>;
  series: Array<{ key: string; label: string; color: string }>; max?: number;
}) {
  const values = series.flatMap((s) => history.map((p) => p[s.key]).filter((v) => typeof v === "number"));
  const min = 0;
  const max = fixedMax ?? Math.max(...values, 1);
  return (
    <div style={{ marginBottom: 12 }}>
      <Flex align="center" gap={12} style={{ marginBottom: 4 }}>
        <strong style={{ fontSize: 12 }}>{title}</strong>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{count} 轮</Typography.Text>
        {series.map((s) => (
          <span key={s.key} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            <i style={{ width: 10, height: 3, background: s.color, display: "inline-block", borderRadius: 2 }} />
            {s.label}
          </span>
        ))}
      </Flex>
      <svg viewBox="0 0 100 80" preserveAspectRatio="none" role="img" aria-label={title} style={{ width: "100%", height: 80 }}>
        <path d="M0 72H100" stroke="#dbe4ef" />
        {series.map((s) => (
          <path key={s.key} d={chartPath(history, s.key, min, max)} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
    </div>
  );
}

function chartPath(history: Array<Record<string, number>>, key: string, min: number, max: number): string {
  const span = Math.max(max - min, 0.00001);
  return history.map((point, index) => {
    const v = point[key];
    if (typeof v !== "number") return "";
    const x = index * (100 / Math.max(history.length - 1, 1));
    const y = 72 - ((v - min) / span) * 64;
    return `${index ? "L" : "M"}${x} ${Math.min(72, Math.max(8, y))}`;
  }).filter(Boolean).join(" ");
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(3);
}

function formatSeconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1) return `${Math.round(value * 1000)}ms`;
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}
