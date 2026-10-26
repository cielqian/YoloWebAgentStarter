import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import { TrainingComputeRail } from "../components/training/TrainingComputeRail";
import { TrainingConfigPanel } from "../components/training/TrainingConfigPanel";
import { TrainingTaskDetailCard } from "../components/training/TrainingTaskDetailCard";
import { TrainingTaskList } from "../components/training/TrainingTaskList";
import {
  PRESETS,
  applyTaskToForm,
  defaultForm,
  defaultRemoteSelection,
  defaultModelFor,
  estimateMinutes,
  pickPreset,
  taskTypeLabel,
  type HistoryFilter,
  type PresetId,
  type TrainingFormState,
} from "../training/helpers";
import type { Dataset, TaskType, TrainingDevice, TrainingLog, TrainingNodeStatus, TrainingSummary, TrainingTask } from "../types";

interface Props {
  datasets: Dataset[];
  /** 新建训练的目标数据集；未选中时回退到列表第一个数据集，列表模式可无数据集浏览。 */
  dataset?: Dataset;
  onDatasetChange: (dataset: Dataset) => void;
  onOpenModels?: () => void;
  onAskAgent?: (task: TrainingTask) => void;
  focusTaskId?: string;
  onFocusTaskConsumed?: () => void;
  autoCreateDatasetId?: string;
  onAutoCreateConsumed?: () => void;
}

const DRAFT_KEY = "ywa.training.draft";

type PageMode = "list" | "create";

export function TrainingView({
  datasets,
  dataset,
  onDatasetChange,
  onOpenModels,
  onAskAgent,
  focusTaskId,
  onFocusTaskConsumed,
  autoCreateDatasetId,
  onAutoCreateConsumed,
}: Props) {
  const activeDataset = dataset ?? datasets[0];
  const [tasks, setTasks] = useState<TrainingTask[]>([]);
  const [mode, setMode] = useState<PageMode>("list");
  const [detailTaskId, setDetailTaskId] = useState<string>();
  const [logs, setLogs] = useState<TrainingLog>();
  const [summary, setSummary] = useState<TrainingSummary>();
  const [form, setForm] = useState<TrainingFormState>(() => defaultForm(activeDataset?.task_type ?? "detect"));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [devices, setDevices] = useState<TrainingDevice[]>([]);
  const devicesRef = useRef<TrainingDevice[]>([]);
  const [nodes, setNodes] = useState<TrainingNodeStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [splitRecovery, setSplitRecovery] = useState(false);
  const [expSearch, setExpSearch] = useState("");
  const [expFilter, setExpFilter] = useState<HistoryFilter>("all");

  const preset = pickPreset(form);
  const activeTask = useMemo(
    () => tasks.find((task) => task.status === "running" || task.status === "pending" || task.status === "dispatching"),
    [tasks],
  );
  const hasActiveTask = activeTask !== undefined;
  const detailTask = useMemo(
    () => tasks.find((task) => task.id === detailTaskId) ?? (detailTaskId ? activeTask : undefined),
    [tasks, detailTaskId, activeTask],
  );

  const refresh = useCallback(async () => {
    const result = await api.listTrainingTasks();
    setTasks(result.items);
  }, []);

  useEffect(() => {
    refresh().catch((reason) => setError(errorMessage(reason)));
  }, [refresh]);

  useEffect(() => {
    if (!focusTaskId) return;
    setMode("list");
    setDetailTaskId(focusTaskId);
    onFocusTaskConsumed?.();
  }, [focusTaskId, onFocusTaskConsumed]);

  useEffect(() => {
    if (!autoCreateDatasetId) return;
    setMode("create");
    onAutoCreateConsumed?.();
    scrollToId("training-config-anchor");
  }, [autoCreateDatasetId, onAutoCreateConsumed]);

  useEffect(() => {
    if (typeof api.listTrainingDevices !== "function") return;
    api.listTrainingDevices().then((result) => {
      devicesRef.current = result.items;
      setDevices(result.items);
      setNodes(result.nodes ?? []);
      setForm((prev) => {
        if (prev.node_id) return prev;
        const selection = defaultRemoteSelection(result.items);
        return selection ? { ...prev, ...selection } : prev;
      });
    }).catch((reason) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    if (!activeDataset) return;
    setForm(() => {
      const base = defaultForm(activeDataset.task_type);
      const selection = defaultRemoteSelection(devicesRef.current);
      return selection ? { ...base, ...selection } : base;
    });
    setError("");
    setNotice("");
    setSplitRecovery(false);
  }, [activeDataset?.id, activeDataset?.task_type]);

  useEffect(() => {
    if (mode !== "create") return;
    const timer = window.setInterval(() => {
      api.listTrainingDevices().then((result) => {
        devicesRef.current = result.items;
        setDevices(result.items);
        setNodes(result.nodes ?? []);
      }).catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (!hasActiveTask) return;
    const timer = window.setInterval(() => refresh().catch((reason) => setError(errorMessage(reason))), 1500);
    return () => window.clearInterval(timer);
  }, [refresh, hasActiveTask]);

  useEffect(() => {
    const task = detailTask ?? activeTask;
    if (!task) {
      setLogs(undefined);
      setSummary(undefined);
      return;
    }
    const taskId = task.id;
    const active = task.status === "pending" || task.status === "running";
    let cancelled = false;
    const loadDetail = async () => {
      try {
        const [nextLogs, nextSummary] = await Promise.all([
          api.getTrainingLogs(taskId),
          api.getTrainingSummary(taskId),
        ]);
        if (!cancelled) {
          setLogs(nextLogs);
          setSummary(nextSummary);
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason));
      }
    };
    void loadDetail();
    if (!active) return () => { cancelled = true; };
    const timer = window.setInterval(() => void loadDetail(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [detailTask?.id, detailTask?.status, activeTask?.id, activeTask?.status]);

  const applyPreset = (id: PresetId) => {
    const next = PRESETS[id];
    setForm((prev) => ({
      ...prev,
      epochs: next.epochs,
      batch_size: next.batch_size,
      img_size: next.img_size,
      patience: String(next.patience),
      model: prev.model || defaultModelFor(activeDataset?.task_type ?? "detect"),
    }));
  };

  const canSubmit = Boolean(form.node_id && form.node_device);

  const riskText = !activeDataset || activeDataset.image_count < 2
    ? "图片不足 2 张时无法同时构成 train / val，创建任务可能失败。"
    : `将使用已持久化的 split 训练 ${taskTypeLabel(activeDataset.task_type)} 模型；请确认 train 与 val 均非空。`;

  const deviceSummaryText = form.node_id
    ? `${devices.find((item) => item.node_id === form.node_id)?.node_name ?? "节点"} · ${form.node_device ?? "auto"}`
    : "未选择节点";

  const summaryBottomBar = `${form.model} · ${form.epochs} ep · batch ${form.batch_size} · ${form.img_size}px · ${deviceSummaryText} · 约 ${estimateMinutes(form.epochs, activeDataset?.image_count ?? 0, form.batch_size, Math.max(form.node_device?.split(",").filter(Boolean).length ?? 1, 1))} 分钟`;

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setSplitRecovery(false);
    try {
      if (!activeDataset) {
        setError("请先创建或导入一个数据集，再新建训练任务。");
        return;
      }
      if (!form.node_id) {
        setError("请先在右侧选择训练节点与设备。");
        return;
      }
      const patience = form.patience.trim() ? Number(form.patience) : undefined;
      const lr0 = form.lr0.trim() ? Number(form.lr0) : undefined;
      const task = await api.createTrainingTask({
        dataset_id: activeDataset.id,
        name: form.name.trim() || "local-training",
        model: form.model.trim() || defaultModelFor(activeDataset.task_type),
        task_type: activeDataset.task_type as TaskType,
        epochs: form.epochs,
        img_size: form.img_size,
        batch_size: form.batch_size,
        device: form.node_device ?? "auto",
        node_id: form.node_id ?? undefined,
        workers: form.workers,
        seed: form.seed,
        val_ratio: form.val_ratio,
        optimizer: form.optimizer.trim() || undefined,
        lr0: Number.isFinite(lr0) ? lr0 : undefined,
        patience: Number.isFinite(patience) ? patience : undefined,
      });
      setTasks((items) => [task, ...items]);
      setMode("list");
      setDetailTaskId(task.id);
      setNotice(task.status === "pending"
        ? "目标设备占用中，任务已加入排队队列，前一任务完成后自动执行。"
        : task.status === "dispatching"
          ? "任务已创建，正在后台下发数据集，进度见记录列表。"
          : "训练任务已创建并开始执行。");
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      setSplitRecovery(message.includes("at least one train image and one val image"));
    } finally {
      setBusy(false);
    }
  };

  const autoSplitForTraining = async () => {
    if (!activeDataset) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.autoSplitImages(activeDataset.id, { train_ratio: 0.8, val_ratio: 0.2, test_ratio: 0, seed: 42 });
      setSplitRecovery(false);
      setNotice(`已按 80/20 分配 ${result.updated} 张图片：train ${result.split_counts.train}，val ${result.split_counts.val}。现在可以重新创建训练。`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (taskId: string) => {
    setBusy(true);
    try {
      await api.stopTrainingTask(taskId);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (task: TrainingTask) => {
    if (!window.confirm(`删除训练记录「${task.name}」？任务目录与日志会一并清除，已注册的模型不受影响。`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteTrainingTask(task.id);
      if (detailTaskId === task.id) setDetailTaskId(undefined);
      await refresh();
      setNotice("训练记录已删除。");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const resume = async (task: TrainingTask) => {
    setBusy(true);
    setError("");
    try {
      const restoreEpochState = task.status !== "completed" && !task.node_id;
      const next = await api.resumeTrainingTask(task.id, restoreEpochState ? { resume_epoch: true } : { epochs: form.epochs, resume_epoch: false });
      setTasks((items) => [next, ...items]);
      setDetailTaskId(next.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => {
    if (!activeDataset) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ datasetId: activeDataset.id, form }));
      setNotice("草稿配置已保存到本机浏览器。");
    } catch {
      setError("无法写入本地草稿。");
    }
  };

  const openCreateWithTask = (task: TrainingTask) => {
    // 从任务记录复用配置时切到该任务的数据集，任务类型才能与提交的数据集匹配。
    const taskDataset = datasets.find((item) => item.id === task.dataset_id);
    if (taskDataset && taskDataset.id !== activeDataset?.id) onDatasetChange(taskDataset);
    setForm(applyTaskToForm(task));
    setAdvancedOpen(true);
    setMode("create");
    setNotice(`已填入「${task.name}」的配置，可直接调整后提交。`);
    scrollToId("training-config-anchor");
  };

  const scrollToDetail = () => {
    scrollToId("training-task-detail");
  };

  return (
    <main className="training-layout training-workspace-page">
      <header className="training-page-header">
        <div className="training-page-header-main">
          <div>
            <span className="eyebrow">{mode === "create" && activeDataset ? `TRAINING / ${activeDataset.task_type.toUpperCase()}` : "TRAINING"}</span>
            <h1>训练工作区</h1>
            <p className="muted">
              {mode === "create"
                ? (form.node_id ? "复用已保存的 train / val / test split，任务将下发到远程节点运行 Ultralytics YOLO。" : "复用已保存的 train / val / test split，在本机运行 Ultralytics YOLO。")
                : "全部数据集的训练记录；新建训练可下发到本机或远程算力节点执行。"}
            </p>
          </div>
        </div>
        {mode === "create" && activeDataset && (
        <div className="training-page-header-meta" aria-label="当前数据集摘要">
          <span className="training-chip"><strong>{activeDataset.name}</strong></span>
          <span className="training-chip">{activeDataset.image_count} 张图片</span>
          <span className="training-chip">{activeDataset.class_count} 类</span>
          <span className="training-chip training-chip--accent">{taskTypeLabel(activeDataset.task_type)}</span>
        </div>
        )}
      </header>

      {notice && <Toast kind="success" message={notice} onClose={() => setNotice("")} />}
      {error && !splitRecovery && <Toast kind="error" message={error} onClose={() => setError("")} />}
      {splitRecovery && (
        <div className="validation invalid">
          <strong>训练尚未创建</strong>
          <span>{error}</span>
          <div className="training-split-recovery">
            <small>这会重新分配该数据集全部图片的持久化 split；请确认当前 split 不需要保留。</small>
            <button className="button" disabled={busy || (activeDataset?.image_count ?? 0) < 2} onClick={() => void autoSplitForTraining()}>
              自动分配 train / val
            </button>
            {(activeDataset?.image_count ?? 0) < 2 && <small>至少需要两张图片，才能同时创建 train 与 val split。</small>}
          </div>
        </div>
      )}

      {detailTask && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="训练任务详情" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailTaskId(undefined); }}>
          <div className="training-detail-modal">
            {onAskAgent ? <button type="button" className="button training-detail-modal-agent" onClick={() => onAskAgent(detailTask)}>询问智能体：此训练任务</button> : null}
            <TrainingTaskDetailCard
              task={detailTask}
              summary={summary?.task_id === detailTask.id ? summary : undefined}
              logs={logs?.task_id === detailTask.id ? logs.logs : undefined}
              busy={busy}
              onClose={() => setDetailTaskId(undefined)}
              onStop={() => void stop(detailTask.id)}
              onResume={() => void resume(detailTask)}
            />
          </div>
        </div>
      )}

      {mode === "list" ? (
        <div className="training-record-page">
          <TrainingTaskList
            tasks={tasks}
            datasets={datasets}
            selectedTaskId={detailTaskId}
            expSearch={expSearch}
            expFilter={expFilter}
            onSearchChange={setExpSearch}
            onFilterChange={setExpFilter}
            onCreate={() => {
              if (!activeDataset) {
                setNotice("");
                setError("请先创建或导入一个数据集，再新建训练任务。");
                return;
              }
              setMode("create");
              setNotice("");
            }}
            onOpenDetail={(task) => setDetailTaskId(task.id)}
            onApplyTask={openCreateWithTask}
            onStop={(task) => void stop(task.id)}
            onDelete={(task) => void remove(task)}
            onOpenModels={onOpenModels}
          />
        </div>
      ) : activeDataset ? (
        <div className="training-dataset-grid">
          <div className="training-dataset-main training-workspace">
            <TrainingConfigPanel
              datasets={datasets}
              dataset={activeDataset}
              form={form}
              preset={preset}
              advancedOpen={advancedOpen}
              summaryBottomBar={summaryBottomBar}
              onDatasetChange={onDatasetChange}
              onFormChange={setForm}
              onPreset={applyPreset}
              onAdvancedOpenChange={setAdvancedOpen}
              onSubmit={(event) => void start(event)}
              onExit={() => { setNotice(""); setMode("list"); }}
            />
          </div>

          <TrainingComputeRail
            dataset={activeDataset}
            form={form}
            devices={devices}
            nodes={nodes}
            busy={busy}
            canSubmit={canSubmit}
            riskText={riskText}
            onFormChange={setForm}
            onSaveDraft={saveDraft}
          />
        </div>
      ) : null}
    </main>
  );
}

function scrollToId(id: string) {
  window.requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth" });
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。";
}
