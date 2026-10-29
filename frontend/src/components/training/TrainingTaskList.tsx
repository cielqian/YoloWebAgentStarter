import { useMemo } from "react";
import {
  Button as AntdButton,
  Empty,
  Flex,
  Input as AntdInput,
  Progress,
  Segmented,
  Select as AntdSelect,
  Space,
  Tag as AntdTag,
  Typography,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { Dataset, DatasetVersion, TrainingTask } from "../../types";
import {
  formatDuration,
  formatRelativeTime,
  metricNumber,
  statusLabel,
  type HistoryFilter,
} from "../../training/helpers";

interface Props {
  tasks: TrainingTask[];
  datasets: Dataset[];
  historyDatasetId: string;
  historyVersion: string;
  historyVersions: DatasetVersion[];
  onHistoryDatasetChange: (value: string) => void;
  onHistoryVersionChange: (value: string) => void;
  selectedTaskId?: string;
  expSearch: string;
  expFilter: HistoryFilter;
  onSearchChange: (value: string) => void;
  onFilterChange: (value: HistoryFilter) => void;
  onCreate: () => void;
  onOpenDetail: (task: TrainingTask) => void;
  onApplyTask: (task: TrainingTask) => void;
  onStop: (task: TrainingTask) => void;
  onDelete: (task: TrainingTask) => void;
  onOpenModels: (() => void) | undefined;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "default",
  dispatching: "processing",
  running: "processing",
  completed: "success",
  failed: "error",
  stopped: "warning",
};

export function TrainingTaskList({
  tasks,
  datasets,
  historyDatasetId,
  historyVersion,
  historyVersions,
  onHistoryDatasetChange,
  onHistoryVersionChange,
  selectedTaskId,
  expSearch,
  expFilter,
  onSearchChange,
  onFilterChange,
  onCreate,
  onOpenDetail,
  onApplyTask,
  onStop,
  onDelete,
  onOpenModels,
}: Props) {
  const datasetName = useMemo(() => {
    const map = new Map(datasets.map((item) => [item.id, item.name] as const));
    return (id: string) => map.get(id) ?? "未知数据集";
  }, [datasets]);

  const counts = useMemo(
    () => ({
      all: tasks.length,
      running: tasks.filter((t) => ["pending", "dispatching", "running"].includes(t.status)).length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      stopped: tasks.filter((t) => t.status === "stopped").length,
    }),
    [tasks],
  );

  const filteredTasks = useMemo(() => {
    const q = expSearch.trim().toLowerCase();
    return tasks
      .filter((task) => {
        if (historyDatasetId && task.dataset_id !== historyDatasetId) return false;
        if (historyVersion && String(task.dataset_version_number ?? "") !== historyVersion) return false;
        if (expFilter === "running" && !["pending", "dispatching", "running"].includes(task.status)) return false;
        if (expFilter === "completed" && task.status !== "completed") return false;
        if (expFilter === "failed" && task.status !== "failed") return false;
        if (expFilter === "stopped" && task.status !== "stopped") return false;
        if (!q) return true;
        return task.name.toLowerCase().includes(q)
          || task.model_name.toLowerCase().includes(q)
          || task.device.toLowerCase().includes(q)
          || datasetName(task.dataset_id).toLowerCase().includes(q);
      })
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [tasks, expSearch, expFilter, datasetName, historyDatasetId, historyVersion]);

  return (
    <section id="experiment-history">
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Space size={12}>
          <strong style={{ fontSize: 16 }}>训练记录</strong>
          <Typography.Text type="secondary">{counts.all} 条</Typography.Text>
        </Space>
        <AntdButton type="primary" icon={<PlusOutlined />} onClick={onCreate}>新建训练</AntdButton>
      </Flex>

      {/* 工具栏:筛选+搜索+数据集/版本下拉 */}
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={expFilter}
          onChange={(v) => onFilterChange(v as HistoryFilter)}
          options={[
            { value: "all", label: `全部 ${counts.all}` },
            { value: "running", label: `运行中 ${counts.running}` },
            { value: "completed", label: `完成 ${counts.completed}` },
            { value: "failed", label: `失败 ${counts.failed}` },
            { value: "stopped", label: `停止 ${counts.stopped}` },
          ]}
        />
        <AntdInput.Search
          placeholder="搜索名称、模型或数据集…"
          value={expSearch}
          onChange={(e) => onSearchChange(e.target.value)}
          allowClear
          style={{ width: 200 }}
        />
        <AntdSelect
          value={historyDatasetId || undefined}
          placeholder="全部数据集"
          allowClear
          onChange={(v) => onHistoryDatasetChange(v ?? "")}
          options={datasets.map((d) => ({ value: d.id, label: d.name }))}
          style={{ minWidth: 140 }}
        />
        <AntdSelect
          value={historyVersion || undefined}
          placeholder="全部版本"
          allowClear
          disabled={!historyDatasetId}
          onChange={(v) => onHistoryVersionChange(v ?? "")}
          options={historyVersions.map((v) => ({ value: String(v.version_number), label: v.version_label || `v${v.version_number}` }))}
          style={{ minWidth: 100 }}
        />
      </Flex>

      {!tasks.length ? (
        <Empty description="还没有训练记录。新建训练任务并下发执行，记录会出现在这里。">
          <AntdButton type="primary" icon={<PlusOutlined />} onClick={onCreate}>新建训练</AntdButton>
        </Empty>
      ) : !filteredTasks.length ? (
        <Empty description="没有匹配的训练记录。">
          <AntdButton onClick={() => { onFilterChange("all"); onSearchChange(""); }}>清除筛选</AntdButton>
        </Empty>
      ) : (
        <Flex vertical gap={8}>
          {filteredTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              datasetLabel={datasetName(task.dataset_id)}
              selected={selectedTaskId === task.id}
              onOpenDetail={onOpenDetail}
              onApplyTask={onApplyTask}
              onStop={onStop}
              onDelete={onDelete}
              onOpenModels={onOpenModels}
            />
          ))}
        </Flex>
      )}
    </section>
  );
}

function TaskCard({
  task,
  datasetLabel,
  selected,
  onOpenDetail,
  onApplyTask,
  onStop,
  onDelete,
  onOpenModels,
}: {
  task: TrainingTask;
  datasetLabel: string;
  selected: boolean;
  onOpenDetail: (task: TrainingTask) => void;
  onApplyTask: (task: TrainingTask) => void;
  onStop: (task: TrainingTask) => void;
  onDelete: (task: TrainingTask) => void;
  onOpenModels: (() => void) | undefined;
}) {
  const map50 = metricNumber(task.metrics_json?.map50);
  const precision = metricNumber(task.metrics_json?.precision);
  const recall = metricNumber(task.metrics_json?.recall);
  const duration = formatDuration(task.started_at, task.finished_at);
  const when = formatRelativeTime(task.finished_at || task.started_at || task.created_at);
  const progress = Math.min(100, Math.max(0, task.progress_percent || 0));
  const isRunning = ["pending", "dispatching", "running"].includes(task.status);
  const showProgress = isRunning || task.status === "stopped" || task.status === "failed";

  return (
    <div
      onClick={() => onOpenDetail(task)}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
        border: selected ? "2px solid #3157d5" : "1px solid #e7eaf0",
        borderRadius: 8, background: selected ? "#f0f4ff" : "#fff", cursor: "pointer",
      }}
    >
      <AntdTag color={STATUS_COLOR[task.status] ?? "default"}>{statusLabel(task.status)}</AntdTag>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap={8}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.name}</strong>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {datasetLabel}{task.dataset_version_number != null ? ` · v${task.dataset_version_number}` : ""}
          </Typography.Text>
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {task.model_name} · {task.epochs} ep · batch {task.batch_size} · {task.img_size}px · {task.device}
        </Typography.Text>
        {task.status === "failed" && task.error_message && (
          <Typography.Text type="danger" style={{ fontSize: 11, display: "block", marginTop: 2 }}>
            {task.error_message.slice(0, 80)}{task.error_message.length > 80 ? "…" : ""}
          </Typography.Text>
        )}
      </div>

      {map50 !== undefined && (
        <Space size={12} style={{ flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "#7d8799" }}>mAP50 <strong style={{ color: "#273248" }}>{fmt(map50)}</strong></span>
          <span style={{ fontSize: 11, color: "#7d8799" }}>P <strong style={{ color: "#273248" }}>{fmt(precision)}</strong></span>
          <span style={{ fontSize: 11, color: "#7d8799" }}>R <strong style={{ color: "#273248" }}>{fmt(recall)}</strong></span>
        </Space>
      )}

      {showProgress && (
        <Progress
          percent={progress}
          size="small"
          style={{ width: 100, margin: 0, flexShrink: 0 }}
          format={() => `${task.progress_epoch}/${task.progress_total_epochs || task.epochs}`}
        />
      )}

      <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0, textAlign: "right" }}>
        <div>{when}</div>
        {duration && <div style={{ fontSize: 10 }}>{duration}</div>}
      </Typography.Text>

      <Space size={4} onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
        <AntdButton type="link" size="small" onClick={() => onOpenDetail(task)}>详情</AntdButton>
        {isRunning && <AntdButton type="link" size="small" danger onClick={() => onStop(task)}>停止</AntdButton>}
        <AntdButton type="link" size="small" onClick={() => onApplyTask(task)}>重试配置</AntdButton>
        {task.status === "completed" && onOpenModels && (
          <AntdButton type="link" size="small" onClick={onOpenModels}>模型库</AntdButton>
        )}
        {task.status !== "running" && (
          <AntdButton type="link" size="small" danger onClick={() => onDelete(task)}>删除</AntdButton>
        )}
      </Space>
    </div>
  );
}

function fmt(value: number | undefined): string {
  return value !== undefined ? value.toFixed(2) : "—";
}
