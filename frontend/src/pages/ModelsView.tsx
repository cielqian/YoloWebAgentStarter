import { useCallback, useEffect, useMemo, useState } from "react";
import { Breadcrumb, Button as AntdButton, Checkbox, Empty as AntdEmpty, Flex, Form, Input as AntdInput, InputNumber, Modal, Segmented, Select as AntdSelect, Space, Table, Tag as AntdTag, Typography, type TableProps } from "antd";
import { api, apiUrl } from "../api/client";
import { Toast } from "../components/Toast";
import { confirmDialog } from "../components/confirm";
import type { Dataset, DatasetVersion, FtpEntry, ModelComparison, ModelEvaluationRecord, ModelVersion, SplitName, TrainingNode } from "../types";
import { ModelTestModal } from "../components/ModelTestModal";
import { ModelComparisonBar } from "../components/model-list/ModelComparisonBar";
import { ModelLibraryStats } from "../components/model-list/ModelLibraryStats";
import { ModelDetailView } from "../components/model-detail/ModelDetailView";
import { formatDelta, formatMetric, pickBestModel } from "../models/helpers";
import { formatRelativeTime } from "../training/helpers";

interface Props {
  /** 模型库按 数据集 → 版本 → 格式(PT/ONNX/OM) 组织展示。 */
  datasets: Dataset[];
  focusModelId?: string;
  onFocusModelConsumed?: () => void;
  onAskAgent?: (model: ModelVersion) => void;
}

const UNLINKED = "__unlinked__";

type VersionTree = Map<number | null, ModelVersion[]>;

const FORMAT_SECTIONS = [
  { format: "pt", title: "PT 模型", hint: "该版本暂无 PT 训练产物；完成一次训练后 best.pt / last.pt 会自动进入这里。" },
  { format: "onnx", title: "ONNX 模型", hint: "该版本暂无 ONNX；在 PT 模型行点击「ONNX」导出 FP32 ONNX。" },
  { format: "om", title: "OM 模型（华为昇腾）", hint: "该版本暂无 OM；在 ONNX 模型行点击「转OM」，经 ATC 转换生成昇腾 .om。" },
] as const;

export function ModelsView({ datasets, focusModelId, onFocusModelConsumed, onAskAgent }: Props) {
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [detailId, setDetailId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [compareBusy, setCompareBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState<ModelVersion>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ModelComparison>();
  const [evaluations, setEvaluations] = useState<ModelEvaluationRecord[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [nodes, setNodes] = useState<TrainingNode[]>([]);
  const [omTarget, setOmTarget] = useState<ModelVersion>();
  const [onnxTarget, setOnnxTarget] = useState<ModelVersion>();
  const [onnxBatch, setOnnxBatch] = useState(1);
  const [onnxDynamic, setOnnxDynamic] = useState(false);
  const [onnxImgsz, setOnnxImgsz] = useState(640);
  const [onnxOpset, setOnnxOpset] = useState(11);
  const [omNodeId, setOmNodeId] = useState("");
  const [omSocVersion, setOmSocVersion] = useState("Ascend310P3");
  const [omInputShape, setOmInputShape] = useState("images:1,3,640,640");
  const [versionLists, setVersionLists] = useState<Record<string, DatasetVersion[]>>({});
  const [drillDataset, setDrillDataset] = useState<string>();
  const [ftpTarget, setFtpTarget] = useState<ModelVersion>();
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpEntries, setFtpEntries] = useState<FtpEntry[]>([]);
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpError, setFtpError] = useState("");
  const [ftpFileName, setFtpFileName] = useState("");
  const [ftpBusy, setFtpBusy] = useState(false);
  const [drillVersion, setDrillVersion] = useState<number | null>();

  const refresh = useCallback(async () => {
    const result = await api.listModels(undefined, true);
    const items = [...result.items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    setModels(items);
    setDetailId((current) => (current && items.some((item) => item.id === current) ? current : undefined));
    setSelectedIds((ids) => ids.filter((id) => items.some((item) => item.id === id)));
  }, []);

  useEffect(() => {
    refresh().catch((reason) => setError(errorMessage(reason)));
  }, [refresh]);

  useEffect(() => {
    if (!models.some((model) => model.status === "converting")) return;
    const timer = window.setInterval(() => {
      api.listModels(undefined, true)
        .then((result) => {
          const items = [...result.items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          for (const model of items) {
            const previous = models.find((item) => item.id === model.id);
            if (!previous || previous.status !== "converting") continue;
            if (model.status === "active") setNotice(`OM 转换完成：${model.name}`);
            if (model.status === "failed") setError(`OM 转换失败：${model.notes || "未知原因"}`);
          }
          setModels(items);
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [models]);

  const detailModel = useMemo(() => models.find((item) => item.id === detailId), [models, detailId]);
  const detailDataset = useMemo(
    () => (detailModel?.dataset_id ? datasets.find((item) => item.id === detailModel.dataset_id) : undefined),
    [datasets, detailModel?.dataset_id],
  );
  const datasetName = useCallback(
    (datasetId: string) => (datasetId === UNLINKED ? "未关联数据集" : datasets.find((item) => item.id === datasetId)?.name ?? "未关联数据集"),
    [datasets],
  );
  const datasetKey = useCallback(
    (datasetId: string | null) => (datasetId && datasets.some((item) => item.id === datasetId) ? datasetId : UNLINKED),
    [datasets],
  );

  useEffect(() => {
    if (!detailModel || detailModel.format !== "pt") { setEvaluations([]); return; }
    api.listModelEvaluations(detailModel.id).then(setEvaluations).catch((reason) => setError(errorMessage(reason)));
  }, [detailModel?.id, detailModel?.format]);

  useEffect(() => {
    if (!detailModel || !evaluations.some((item) => item.status === "pending" || item.status === "running")) return;
    const timer = window.setInterval(() => {
      api.listModelEvaluations(detailModel.id).then(setEvaluations).catch((reason) => setError(errorMessage(reason)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [evaluations, detailModel?.id]);

  const visibleModels = useMemo(
    () => (includeArchived ? models : models.filter((model) => model.status !== "archived")),
    [models, includeArchived],
  );
  const searchedModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleModels;
    return visibleModels.filter((model) =>
      model.name.toLowerCase().includes(q)
      || model.version.toLowerCase().includes(q)
      || model.format.toLowerCase().includes(q));
  }, [visibleModels, search]);

  // 模型分组:数据集 → 版本
  const tree = useMemo(() => {
    const byDataset = new Map<string, VersionTree>();
    for (const model of searchedModels) {
      const key = datasetKey(model.dataset_id);
      let versions = byDataset.get(key);
      if (!versions) {
        versions = new Map();
        byDataset.set(key, versions);
      }
      const versionKey = model.dataset_version_number ?? null;
      versions.set(versionKey, [...(versions.get(versionKey) ?? []), model]);
    }
    return byDataset;
  }, [searchedModels, datasetKey]);

  const bestModel = useMemo(
    () => pickBestModel(models.filter((model) => model.status === "active" && model.format === "pt")),
    [models],
  );

  // 下钻到数据集时拉取版本列表
  useEffect(() => {
    if (!drillDataset || drillDataset === UNLINKED || versionLists[drillDataset]) return;
    let cancelled = false;
    api.listDatasetVersions(drillDataset)
      .then((list) => { if (!cancelled) setVersionLists((prev) => ({ ...prev, [drillDataset]: list })); })
      .catch(() => { if (!cancelled) setVersionLists((prev) => ({ ...prev, [drillDataset]: [] })); });
    return () => { cancelled = true; };
  }, [drillDataset, versionLists]);

  useEffect(() => {
    if (!focusModelId) return;
    const target = models.find((item) => item.id === focusModelId);
    if (target) {
      setDrillDataset(datasetKey(target.dataset_id));
      setDrillVersion(target.dataset_version_number ?? null);
    }
    setDetailId(focusModelId);
    onFocusModelConsumed?.();
  }, [focusModelId, onFocusModelConsumed, models, datasetKey]);

  const selectedModels = useMemo(
    () => (drillDataset && drillVersion !== undefined ? tree.get(drillDataset)?.get(drillVersion) ?? [] : []),
    [tree, drillDataset, drillVersion],
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  const exportOnnx = (model: ModelVersion) => run(async () => {
    const exported = await api.exportModelOnnx(model.id);
    await refresh();
    setDetailId(exported.id);
    setNotice(`已导出 ONNX：${exported.name}`);
  });

  const parentFtpPath = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";

  const loadFtpDirs = async (path: string) => {
    setFtpLoading(true);
    setFtpError("");
    try {
      const result = await api.listFtp(path);
      setFtpPath(result.path);
      setFtpEntries((result.entries ?? []).filter((entry) => entry.is_dir));
    } catch (reason) {
      setFtpError(errorMessage(reason));
    } finally {
      setFtpLoading(false);
    }
  };

  const ftpDefaultName = (target: ModelVersion): string => {
    const extension = ((target.model_path.split("/").pop() ?? target.name).match(/\.[^.]+$/) ?? [".om"])[0];
    let current: ModelVersion | undefined = target;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const base = (current.model_path.split("/").pop() || current.name).replace(/_(best|last)(\.[^.]+)$/i, "$2");
      const stem = base.replace(/\.[^.]+$/, "");
      if (stem && stem.toLowerCase() !== "model") return `${stem}${extension}`;
      current = models.find((item) => item.id === current?.source_model_id);
    }
    return `${(target.name.replace(/\.[^.]+$/, "").replace(/_(best|last)$/i, "") || "model")}${extension}`;
  };

  const openFtpSave = (model: ModelVersion) => {
    const fileName = ftpDefaultName(model);
    setFtpTarget(model);
    setFtpFileName(fileName);
    setFtpEntries([]);
    setFtpError("");
    setFtpPath("/");
    void loadFtpDirs("/");
  };

  const submitFtpSave = async () => {
    if (!ftpTarget || !ftpFileName.trim()) return;
    const name = ftpFileName.trim().replace(/[/\\]+/g, "_");
    setFtpBusy(true);
    setFtpError("");
    try {
      const response = await fetch(apiUrl(`/api/models/${ftpTarget.id}/download`));
      if (!response.ok) throw new Error(`下载模型失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      await api.uploadFtp(ftpPath, [new File([blob], name)]);
      setNotice(`已转存到 FTP：${ftpPath === "/" ? "" : ftpPath}/${name}（同名文件已覆盖）`);
      setFtpTarget(undefined);
    } catch (reason) {
      setFtpError(errorMessage(reason));
    } finally {
      setFtpBusy(false);
    }
  };

  const submitOnnxExport = () => {
    if (!onnxTarget) return;
    const target = onnxTarget;
    void run(async () => {
      const exported = await api.exportModelOnnx(target.id, { batch: onnxBatch, dynamic: onnxDynamic, imgsz: onnxImgsz, opset: onnxOpset });
      setOnnxTarget(undefined);
      await refresh();
      setDetailId(exported.id);
      setNotice(`已导出 ONNX：${exported.name}（batch ${onnxBatch}${onnxDynamic ? " · 动态" : ""} · imgsz ${onnxImgsz} · opset ${onnxOpset}）`);
    });
  };

  const openOmConvert = (model: ModelVersion) => {
    setOmTarget(model);
    if (nodes.length) return;
    api.listOmNodes()
      .then((list) => {
        setNodes(list);
        setOmNodeId((current) => current || (list.find((item) => item.enabled)?.id ?? ""));
      })
      .catch((reason) => setError(errorMessage(reason)));
  };

  const submitOmConvert = () => {
    if (!omTarget || !omNodeId) return;
    const target = omTarget;
    void run(async () => {
      const job = await api.convertModelToOm(target.id, {
        node_id: omNodeId,
        soc_version: omSocVersion.trim() || "Ascend310P3",
        input_shape: omInputShape.trim() || "images:1,3,640,640",
      });
      setOmTarget(undefined);
      await refresh();
      setNotice(`已提交 OM 转换：${target.name} → ${job.node_name}，新模型行展示转换进度`);
    });
  };

  const toggleArchive = (model: ModelVersion) => run(async () => {
    const updated = model.status === "archived" ? await api.restoreModel(model.id) : await api.archiveModel(model.id);
    await refresh();
    setDetailId(updated.id);
  });

  const remove = (model: ModelVersion) => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: `删除模型「${model.name}」？`,
        description: "模型文件会从平台永久删除，不可恢复。",
        confirmLabel: "删除模型",
      });
      if (!confirmed) return;
      await run(async () => {
        await api.deleteModel(model.id);
        if (detailId === model.id) setDetailId(undefined);
        await refresh();
      });
    })();
  };

  const removeSelected = () => {
    if (!selectedIds.length) return;
    void (async () => {
      const confirmed = await confirmDialog({
        title: `删除选中的 ${selectedIds.length} 个模型？`,
        description: "所选模型文件会从平台永久删除，不可恢复。",
        confirmLabel: "批量删除",
      });
      if (!confirmed) return;
      await run(async () => {
        for (const id of selectedIds) await api.deleteModel(id);
        setSelectedIds([]);
        setComparison(undefined);
        if (detailId && selectedIds.includes(detailId)) setDetailId(undefined);
        await refresh();
      });
    })();
  };

  const compareSelected = async () => {
    if (selectedIds.length !== 2) return;
    setCompareBusy(true);
    setError("");
    try {
      setComparison(await api.compareModels(selectedIds[0], selectedIds[1]));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCompareBusy(false);
    }
  };

  const compareWithBest = async () => {
    if (!bestModel || !selectedIds.length) return;
    const candidate = selectedIds.find((id) => id !== bestModel.id) ?? selectedIds[0];
    if (candidate === bestModel.id) {
      setError("请选择与最佳模型不同的候选模型。");
      return;
    }
    setCompareBusy(true);
    setError("");
    try {
      setComparison(await api.compareModels(bestModel.id, candidate));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCompareBusy(false);
    }
  };

  const evaluate = (split: SplitName) => detailModel && run(async () => {
    const record = await api.evaluateModel(detailModel.id, split);
    setEvaluations((items) => [record, ...items]);
  });

  if (detailModel) {
    return (
      <main className="models-layout models-workspace-page">
        {error && <Toast kind="error" message={error} onClose={() => setError("")} />}
        {notice && <Toast kind="success" message={notice} onClose={() => setNotice("")} />}
        {onAskAgent ? <AntdButton onClick={() => onAskAgent(detailModel)}>询问智能体：此模型</AntdButton> : null}
        <ModelDetailView
          dataset={detailDataset}
          model={detailModel}
          models={models}
          evaluations={evaluations}
          busy={busy}
          onBack={() => setDetailId(undefined)}
          onSelectModel={(model) => setDetailId(model.id)}
          onTest={setTesting}
          onExportOnnx={() => void exportOnnx(detailModel)}
          onToggleArchive={() => void toggleArchive(detailModel)}
          onDelete={() => remove(detailModel)}
          onEvaluate={evaluate}
          onSaved={async (updated) => {
            setDetailId(updated.id);
            await refresh();
            setNotice("元数据已保存");
          }}
        />
        {testing && <ModelTestModal model={testing} onClose={() => setTesting(undefined)} />}
      </main>
    );
  }

  if (!models.length && !datasets.length) {
    return (
      <main className="models-layout models-workspace-page">
        {error && <Toast kind="error" message={error} onClose={() => setError("")} />}
        <header className="models-page-header">
          <div>
            <Typography.Text type="secondary" className="models-eyebrow">MODEL REGISTRY</Typography.Text>
            <Typography.Title level={3} style={{ margin: 0 }}>模型库</Typography.Title>
          </div>
        </header>
        <AntdEmpty
          image={AntdEmpty.PRESENTED_IMAGE_SIMPLE}
          description={(
            <span>
              <strong>暂无模型</strong>
              <br />
              <Typography.Text type="secondary">完成训练后，best.pt 与 last.pt 会自动进入模型库，并可继续导出 ONNX / 转换 OM。</Typography.Text>
            </span>
          )}
        />
      </main>
    );
  }

  const treeEntries: Array<[string, VersionTree]> = datasets
    .map((dataset) => dataset.id)
    .filter((id) => tree.has(id))
    .map((id) => [id, tree.get(id)!] as [string, VersionTree]);
  if (tree.has(UNLINKED)) treeEntries.push([UNLINKED, tree.get(UNLINKED)!]);

  const versionKeysFor = (datasetId: string, versions: VersionTree): number[] => {
    const numbers = new Set<number>([...versions.keys()].filter((key): key is number => key != null));
    for (const version of versionLists[datasetId] ?? []) numbers.add(version.version_number);
    return [...numbers].sort((a, b) => b - a);
  };
  const isActiveVersion = (datasetId: string, number: number) =>
    (versionLists[datasetId] ?? []).some((version) => version.version_number === number && version.is_active);

  const modelColumns = (format: "pt" | "onnx" | "om"): TableProps<ModelVersion>["columns"] => [
    {
      title: "名称",
      key: "name",
      render: (_, model) => (
        <Space orientation="vertical" size={0} style={{ alignItems: "flex-start" }}>
          <AntdButton type="link" size="small" style={{ padding: 0, height: "auto" }} title={model.name} onClick={() => setDetailId(model.id)}>{model.name}</AntdButton>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{model.version}</Typography.Text>
        </Space>
      ),
    },
    { title: "类型", key: "type", width: 80, render: (_, model) => model.artifact_type.toUpperCase() },
    { title: "mAP50", key: "map50", width: 90, align: "right", render: (_, model) => <span className="model-table-metric">{formatMetric(model.map50)}</span> },
    { title: "mAP50-95", key: "map50_95", width: 100, align: "right", render: (_, model) => <span className="model-table-metric">{formatMetric(model.map50_95)}</span> },
    { title: "Precision", key: "precision", width: 100, align: "right", render: (_, model) => <span className="model-table-metric">{formatMetric(model.precision)}</span> },
    { title: "Recall", key: "recall", width: 90, align: "right", render: (_, model) => <span className="model-table-metric">{formatMetric(model.recall)}</span> },
    { title: "状态", key: "status", width: 110, render: (_, model) => <span className={`model-table-status ${model.status}`}>{modelStatusLabel(model.status)}</span> },
    { title: "创建", key: "created", width: 100, render: (_, model) => <Typography.Text type="secondary" title={model.created_at}>{formatRelativeTime(model.created_at)}</Typography.Text> },
    {
      title: "操作",
      key: "actions",
      width: 300,
      render: (_, model) => {
        if (model.status === "converting") return <Typography.Text type="secondary">转换进行中…</Typography.Text>;
        return (
          <Space size={0} wrap>
            {model.format === "pt" ? (
              <>
                <AntdButton type="link" size="small" autoInsertSpace={false} disabled={busy} onClick={() => setTesting(model)}>测试</AntdButton>
                <AntdButton type="link" size="small" disabled={busy} onClick={() => { setOnnxTarget(model); setOnnxBatch(1); setOnnxDynamic(false); setOnnxImgsz(640); setOnnxOpset(11); }}>转ONNX</AntdButton>
              </>
            ) : null}
            {model.format === "onnx" ? (
              <AntdButton type="link" size="small" disabled={busy} onClick={() => openOmConvert(model)}>转OM</AntdButton>
            ) : null}
            <AntdButton type="link" size="small" disabled={busy} onClick={() => openFtpSave(model)}>转存FTP</AntdButton>
            <AntdButton type="link" size="small" autoInsertSpace={false} onClick={() => setDetailId(model.id)}>详情</AntdButton>
            <AntdButton type="link" size="small" danger autoInsertSpace={false} disabled={busy} onClick={() => remove(model)}>删除</AntdButton>
          </Space>
        );
      },
    },
  ];

  return (
    <main className="models-layout models-workspace-page">
      <header className="models-page-header">
        <div className="models-page-header-main">
          <div>
            <Typography.Text type="secondary" className="models-eyebrow">MODEL REGISTRY</Typography.Text>
            <Typography.Title level={3} style={{ margin: 0 }}>模型库</Typography.Title>
            <Typography.Text type="secondary">按 数据集 → 版本 组织，每个版本下包含 PT / ONNX / OM 三类模型。</Typography.Text>
          </div>
        </div>
        <div className="models-page-header-meta">
          <Space size={8}>
            <AntdTag>{tree.size} 个数据集</AntdTag>
            <AntdTag color="blue">{models.length} 个模型</AntdTag>
          </Space>
        </div>
      </header>

      {error && <Toast kind="error" message={error} onClose={() => setError("")} />}
      {notice && <Toast kind="success" message={notice} onClose={() => setNotice("")} />}

      <ModelLibraryStats
        total={visibleModels.length}
        ptCount={visibleModels.filter((item) => item.format === "pt").length}
        onnxCount={visibleModels.filter((item) => item.format === "onnx").length}
        bestMap50={formatMetric(bestModel?.map50)}
      />

      {comparison && (
        <section className="models-comparison-result">
          <div className="models-comparison-result-head">
            <div>
              <Typography.Text type="secondary" className="models-eyebrow">MODEL COMPARISON</Typography.Text>
              <Typography.Title level={5} style={{ margin: 0 }}>{comparison.candidate.name} vs {comparison.baseline.name}</Typography.Title>
            </div>
            <AntdButton size="small" autoInsertSpace={false} onClick={() => setComparison(undefined)}>关闭</AntdButton>
          </div>
          <div className="models-comparison-deltas">
            {Object.entries(comparison.deltas).map(([key, value]) => (
              <span key={key}>
                <small>{key}</small>
                <strong className={typeof value === "number" ? (value > 0 ? "positive" : value < 0 ? "negative" : undefined) : undefined}>
                  {formatDelta(value)}
                </strong>
              </span>
            ))}
          </div>
          {comparison.suggestions[0] && <Typography.Text type="secondary">{comparison.suggestions[0]}</Typography.Text>}
        </section>
      )}

      <Breadcrumb
        className="models-crumb"
        aria-label="模型库导航"
        items={[
          { title: <button type="button" onClick={() => { setDrillDataset(undefined); setDrillVersion(undefined); }}>模型库</button> },
          ...(drillDataset ? [{ title: <button type="button" onClick={() => setDrillVersion(undefined)}>{datasetName(drillDataset)}</button> }] : []),
          ...(drillDataset && drillVersion !== undefined
            ? [{ title: <span>{drillVersion != null ? `v${drillVersion}` : "未指定版本"}</span> }]
            : []),
        ]}
      />

      {drillDataset === undefined ? (
        <section className="models-library-section">
          <div className="models-library-toolbar">
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>数据集</Typography.Title>
              <Typography.Text type="secondary">选择数据集查看其各版本的模型</Typography.Text>
            </div>
          </div>
          <div className="models-drill-list">
            {treeEntries.map(([datasetId, versions]) => {
              const total = [...versions.values()].reduce((sum, list) => sum + list.length, 0);
              return (
                <AntdButton
                  key={datasetId}
                  type="text"
                  block
                  className="models-drill-row"
                  onClick={() => { setDrillDataset(datasetId); setDrillVersion(undefined); }}
                >
                  <strong>{datasetName(datasetId)}</strong>
                  <small>{versions.size} 个版本 · {total} 个模型</small>
                  <em>›</em>
                </AntdButton>
              );
            })}
          </div>
        </section>
      ) : drillVersion === undefined ? (
        <section className="models-library-section">
          <div className="models-library-toolbar">
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>{datasetName(drillDataset)}</Typography.Title>
              <Typography.Text type="secondary">选择版本查看 PT / ONNX / OM 模型</Typography.Text>
            </div>
          </div>
          <div className="models-drill-list">
            {versionKeysFor(drillDataset, tree.get(drillDataset) ?? new Map()).map((number) => {
              const meta = (versionLists[drillDataset] ?? []).find((version) => version.version_number === number);
              return (
                <AntdButton key={number} type="text" block className="models-drill-row" onClick={() => setDrillVersion(number)}>
                  <strong>v{number}{meta?.is_active ? " · 当前激活" : ""}</strong>
                  <small>{tree.get(drillDataset)?.get(number)?.length ?? 0} 个模型{meta ? ` · ${meta.image_count} 张图` : ""}{meta?.note ? ` · ${meta.note}` : ""}</small>
                  <em>›</em>
                </AntdButton>
              );
            })}
            {(tree.get(drillDataset)?.has(null)) && (
              <AntdButton type="text" block className="models-drill-row" onClick={() => setDrillVersion(null)}>
                <strong>未指定版本</strong>
                <small>{tree.get(drillDataset)?.get(null)?.length ?? 0} 个模型 · 训练时未锁定版本</small>
                <em>›</em>
              </AntdButton>
            )}
          </div>
        </section>
      ) : (
        <section className="models-library-section models-version-pane">
          <Flex justify="space-between" align="flex-start" gap={16} wrap="wrap" style={{ marginBottom: 14 }}>
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>{datasetName(drillDataset)} · {drillVersion != null ? `v${drillVersion}` : "未指定版本"}</Typography.Title>
              <Typography.Text type="secondary">{selectedModels.length} 个模型</Typography.Text>
            </div>
            <Space>
              <AntdInput.Search
                size="small"
                allowClear
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索模型名称 / 版本"
                style={{ width: 220 }}
              />
              <Segmented
                size="small"
                value={includeArchived ? "all" : "active"}
                onChange={(value) => setIncludeArchived(value === "all")}
                options={[{ value: "active", label: "仅启用" }, { value: "all", label: "含归档" }]}
              />
            </Space>
          </Flex>

          {FORMAT_SECTIONS.map(({ format, title, hint }) => {
            const list = selectedModels.filter((model) => model.format === format);
            return (
              <section key={format} className="models-format-section">
                <header>
                  <Typography.Title level={5} style={{ margin: 0 }}>{title}</Typography.Title>
                  <Typography.Text type="secondary">{list.length} 个</Typography.Text>
                </header>
                {list.length ? (
                  <Table<ModelVersion>
                    rowKey="id"
                    size="small"
                    columns={modelColumns(format)}
                    dataSource={list}
                    pagination={false}
                    rowClassName={(model) => model.status}
                    rowSelection={format === "pt" ? {
                      selectedRowKeys: selectedIds.filter((id) => list.some((model) => model.id === id)),
                      onChange: (keys) => setSelectedIds((prev) => [
                        ...prev.filter((id) => !list.some((model) => model.id === id)),
                        ...(keys as string[]),
                      ]),
                      getCheckboxProps: (model) => ({ "aria-label": `选择 ${model.name}` }),
                    } : undefined}
                  />
                ) : (
                  <AntdEmpty image={AntdEmpty.PRESENTED_IMAGE_SIMPLE} description={<Typography.Text type="secondary">{hint}</Typography.Text>} />
                )}
              </section>
            );
          })}
        </section>
      )}

      {onnxTarget && (
        <Modal
          title={`导出 ONNX：${onnxTarget.name}`}
          open
          onCancel={() => setOnnxTarget(undefined)}
          width={520}
          footer={[
            <AntdButton key="cancel" autoInsertSpace={false} onClick={() => setOnnxTarget(undefined)}>取消</AntdButton>,
            <AntdButton key="export" type="primary" disabled={busy} onClick={submitOnnxExport}>开始导出</AntdButton>,
          ]}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            FP32 ONNX，自动化简；文件名与 PT 同名仅换后缀。
          </Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label="batch" style={{ marginBottom: 12 }}>
              <Space>
                <InputNumber min={1} max={64} value={onnxBatch} onChange={(v) => setOnnxBatch(v ?? 1)} style={{ width: 100 }} />
                <Checkbox checked={onnxDynamic} onChange={(e) => setOnnxDynamic(e.target.checked)}>动态尺寸</Checkbox>
              </Space>
            </Form.Item>
            <Form.Item label="imgsz（图像尺寸）" style={{ marginBottom: 12 }}>
              <InputNumber min={32} max={4096} value={onnxImgsz} onChange={(v) => setOnnxImgsz(v ?? 640)} style={{ width: "100%" }} placeholder="640" />
            </Form.Item>
            <Form.Item label="opset" style={{ marginBottom: 0 }}>
              <InputNumber min={7} max={20} value={onnxOpset} onChange={(v) => setOnnxOpset(v ?? 11)} style={{ width: "100%" }} placeholder="11" />
            </Form.Item>
          </Form>
        </Modal>
      )}

      {ftpTarget && (
        <Modal
          className="ftp-picker-dialog"
          title="转存模型到 FTP"
          open
          onCancel={() => setFtpTarget(undefined)}
          width={640}
          footer={null}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            浏览并选择目标目录，可修改保存文件名；同名文件将被覆盖。
          </Typography.Paragraph>
          <div className="ftp-picker">
            <Space wrap style={{ marginBottom: 8 }}>
              <AntdButton size="small" disabled={ftpLoading || ftpPath === "/"} onClick={() => void loadFtpDirs(parentFtpPath(ftpPath))}>返回上级</AntdButton>
              <nav className="ftp-breadcrumb" aria-label="FTP 路径">
                <button disabled={ftpLoading} onClick={() => void loadFtpDirs("/")}>/</button>
                {ftpPath !== "/" && ftpPath.slice(1).split("/").map((crumb, index, parts) => {
                  const target = `/${parts.slice(0, index + 1).join("/")}`;
                  return <span key={target}>/ <button disabled={ftpLoading} onClick={() => void loadFtpDirs(target)}>{crumb}</button></span>;
                })}
              </nav>
              <AntdButton size="small" disabled={ftpLoading} onClick={() => void loadFtpDirs(ftpPath)}>刷新</AntdButton>
            </Space>
            <div className="ftp-picker-list">
              {ftpError ? <Typography.Text type="danger">{ftpError}</Typography.Text> : null}
              {ftpLoading ? (
                <Typography.Text type="secondary">正在读取目录…</Typography.Text>
              ) : ftpEntries.length ? (
                <div className="ftp-dir-list">
                  {ftpEntries.map((entry) => (
                    <AntdButton key={entry.path} type="link" size="small" style={{ padding: 0, height: 24 }} onClick={() => void loadFtpDirs(entry.path)} title="打开目录">
                      <span aria-hidden="true">📁</span> {entry.name}
                    </AntdButton>
                  ))}
                </div>
              ) : (
                <Typography.Text type="secondary">当前目录没有子目录，可直接保存到此处。</Typography.Text>
              )}
            </div>
            <div className="ftp-save-name">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>保存文件名</Typography.Text>
              <AntdInput value={ftpFileName} onChange={(event) => setFtpFileName(event.target.value)} placeholder="例如：blade-detector_best.pt" />
            </div>
            <Flex justify="space-between" align="center" gap={16} style={{ paddingTop: 12, borderTop: "1px solid #f0f0f0" }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>目标目录：{ftpPath}</Typography.Text>
              <Space>
                <AntdButton autoInsertSpace={false} disabled={ftpBusy} onClick={() => setFtpTarget(undefined)}>取消</AntdButton>
                <AntdButton type="primary" autoInsertSpace={false} disabled={ftpBusy || !ftpFileName.trim()} onClick={() => void submitFtpSave()}>{ftpBusy ? "转存中…" : "转存"}</AntdButton>
              </Space>
            </Flex>
          </div>
        </Modal>
      )}

      {omTarget && (
        <Modal
          title={`转换为华为 OM：${omTarget.name}`}
          open
          onCancel={() => setOmTarget(undefined)}
          width={560}
          footer={[
            <AntdButton key="cancel" autoInsertSpace={false} onClick={() => setOmTarget(undefined)}>取消</AntdButton>,
            <AntdButton key="convert" type="primary" disabled={busy || !omNodeId} onClick={submitOmConvert}>开始转换</AntdButton>,
          ]}
        >
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 14 }}>
            把该 ONNX 推到昇腾服务器的 agent 上执行 ATC 转换，完成后 .om 自动回传入库。
          </Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label="转换节点">
              <AntdSelect
                value={omNodeId || undefined}
                onChange={setOmNodeId}
                disabled={!nodes.length}
                placeholder={nodes.length ? "选择转换节点" : "暂无可用节点"}
                options={nodes.map((node) => ({
                  value: node.id,
                  label: `${node.name}（${node.url}）${node.enabled ? "" : " · 已禁用"}`,
                  disabled: !node.enabled,
                }))}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item label="SoC 版本（soc_version）">
              <AntdInput value={omSocVersion} onChange={(event) => setOmSocVersion(event.target.value)} placeholder="Ascend310P3" />
            </Form.Item>
            <Form.Item label="输入形状（input_shape）">
              <AntdInput value={omInputShape} onChange={(event) => setOmInputShape(event.target.value)} placeholder="images:1,3,640,640" />
            </Form.Item>
          </Form>
        </Modal>
      )}

      <ModelComparisonBar
        selectedIds={selectedIds}
        models={visibleModels}
        compareBusy={compareBusy}
        busy={busy}
        onCompareSelected={() => void compareSelected()}
        onCompareWithBest={() => void compareWithBest()}
        onDeleteSelected={removeSelected}
        onDismiss={() => setSelectedIds([])}
      />

      {testing && <ModelTestModal model={testing} onClose={() => setTesting(undefined)} />}
    </main>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。";
}

function modelStatusLabel(status: ModelVersion["status"]): string {
  if (status === "active") return "启用";
  if (status === "archived") return "已归档";
  if (status === "converting") return "OM 转换中";
  return "转换失败";
}
