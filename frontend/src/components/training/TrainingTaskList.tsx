import { useMemo } from "react";
import type { Dataset, TrainingTask } from "../../types";
import {
  formatDuration,
  formatRelativeTime,
  metricNumber,
  statusLabel,
  type HistoryFilter,
} from "../../training/helpers";
import { IconPlus, IconSearch, IconStop } from "./icons";

interface Props {
  tasks: TrainingTask[];
  datasets: Dataset[];
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

export function TrainingTaskList({
  tasks,
  datasets,
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
      running: tasks.filter((task) => ["pending", "dispatching", "running"].includes(task.status)).length,
      completed: tasks.filter((task) => task.status === "completed").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      stopped: tasks.filter((task) => task.status === "stopped").length,
    }),
    [tasks],
  );

  const filters: Array<{ id: HistoryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "running", label: "运行中", count: counts.running },
    { id: "completed", label: "已完成", count: counts.completed },
    { id: "failed", label: "失败", count: counts.failed },
    { id: "stopped", label: "已停止", count: counts.stopped },
  ];

  const filteredTasks = useMemo(() => {
    const q = expSearch.trim().toLowerCase();
    return tasks
      .filter((task) => {
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
  }, [tasks, expSearch, expFilter, datasetName]);

  const searchQuery = expSearch.trim();
  const emptyFilteredMessage = (() => {
    if (searchQuery && expFilter !== "all") return "没有同时匹配筛选与搜索的训练记录。";
    if (searchQuery) return `没有名称包含「${searchQuery}」的训练记录。`;
    return "当前筛选下没有训练记录。";
  })();

  return (
    <section id="experiment-history" className="training-ws-card training-ws-history">
      <div className="training-ws-history-head">
        <div className="training-ws-history-head-row">
          <div>
            <h2>训练记录</h2>
            <p className="training-ws-muted">全部数据集的训练任务；运行中任务自动刷新，点击行查看详情。</p>
          </div>
          <button type="button" className="button primary" onClick={onCreate}>
            <IconPlus /> 新建训练
          </button>
        </div>

        <div className="training-ws-history-toolbar">
          <div className="training-ws-history-filters" role="tablist" aria-label="训练记录筛选">
            {filters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={expFilter === filter.id}
                className={`training-ws-history-filter${expFilter === filter.id ? " active" : ""}`}
                onClick={() => onFilterChange(filter.id)}
              >
                {filter.label}
                <em>{filter.count}</em>
              </button>
            ))}
          </div>
          <label className="training-ws-history-search">
            <IconSearch size={15} />
            <input
              type="search"
              value={expSearch}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索名称、模型或数据集…"
              autoComplete="off"
            />
          </label>
        </div>
      </div>

      {!tasks.length ? (
        <div className="training-ws-history-empty">
          <div className="training-ws-history-empty-icon" aria-hidden>+</div>
          <strong>还没有训练记录</strong>
          <p>新建训练任务并下发执行，记录会出现在这里（本机与远程节点均支持）。</p>
          <button type="button" className="button primary" onClick={onCreate}>新建训练</button>
        </div>
      ) : !filteredTasks.length ? (
        <div className="training-ws-history-empty training-ws-history-empty--filtered">
          <strong>没有匹配的训练记录</strong>
          <p>{emptyFilteredMessage}</p>
          <button type="button" className="button" onClick={() => { onFilterChange("all"); onSearchChange(""); }}>
            清除筛选
          </button>
        </div>
      ) : (
        <div className="training-record-list">
          {filteredTasks.map((task) => (
            <RecordRow
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
        </div>
      )}

      <span className="training-ws-history-count">{counts.all} 条记录</span>
    </section>
  );
}

function RecordRow({
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
  const hasMetrics = map50 !== undefined || precision !== undefined || recall !== undefined;
  const duration = formatDuration(task.started_at, task.finished_at);
  const when = formatRelativeTime(task.finished_at || task.started_at || task.created_at);
  const progress = Math.min(100, Math.max(0, task.progress_percent || 0));
  const isRunning = task.status === "running" || task.status === "pending" || task.status === "dispatching";
  const isDispatching = task.status === "dispatching";
  const showProgress = isRunning || task.status === "stopped" || task.status === "failed";


  return (
    <article
      className={`training-record-row ${task.status}${selected ? " selected" : ""}`}
      onClick={() => onOpenDetail(task)}
    >
      <span className={`training-ws-badge ${task.status}`}>{statusLabel(task.status)}</span>

      <div className="training-record-main">
        <div className="training-record-title">
          <strong title={task.name}>{task.name}</strong>
          <span className="training-record-dataset" title={datasetLabel}>{datasetLabel}</span>
        </div>
        <div className="training-record-chips">
          <span>{task.model_name}</span>
          <span>{task.epochs} ep</span>
          <span>batch {task.batch_size}</span>
          <span>{task.img_size}px</span>
          <span>{task.node_id ? "远程节点" : "本机"} · {task.device}</span>
        </div>
        {task.status === "failed" && task.error_message && (
          <p className="training-record-error" title={task.error_message}>{task.error_message}</p>
        )}
      </div>

      {hasMetrics && (
        <div className="training-record-metrics">
          <div><span>mAP50</span><strong>{fmt(map50)}</strong></div>
          <div><span>P</span><strong>{fmt(precision)}</strong></div>
          <div><span>R</span><strong>{fmt(recall)}</strong></div>
        </div>
      )}

      {showProgress && (
        <div className="training-record-progress">
          <div className="training-record-progress-top">
            <span>{isDispatching ? "数据下发" : `${task.progress_epoch}/${task.progress_total_epochs || task.epochs} ep`}</span>
            <span>{progress.toFixed(0)}%</span>
          </div>
          <div className="training-progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      <div className="training-record-time">
        <span>{when}</span>
        {duration && <small>{duration}</small>}
      </div>

      <div className="training-record-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="training-record-btn training-record-btn--primary" onClick={() => onOpenDetail(task)}>详情</button>
        {isRunning && (
          <button type="button" className="training-record-btn training-record-btn--danger" onClick={() => onStop(task)}>
            <IconStop size={13} /> 停止
          </button>
        )}
        <button type="button" className="training-record-btn" onClick={() => onApplyTask(task)}>重试配置</button>
        {task.status === "completed" && onOpenModels && (
          <button type="button" className="training-record-btn" onClick={onOpenModels}>模型库</button>
        )}
        {task.status !== "running" && (
          <button type="button" className="training-record-btn training-record-btn--danger" onClick={() => onDelete(task)}>删除</button>
        )}
      </div>
    </article>
  );
}

function fmt(value: number | undefined): string {
  return value !== undefined ? value.toFixed(2) : "—";
}
