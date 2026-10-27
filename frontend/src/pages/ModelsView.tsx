import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, apiUrl } from "../api/client";
import { Toast } from "../components/Toast";
import type { Dataset, DatasetVersion, FtpEntry, ModelComparison, ModelEvaluationRecord, ModelVersion, SplitName, TrainingNode } from "../types";
import { ModelTestModal } from "../components/ModelTestModal";
import { ModelComparisonBar } from "../components/model-list/ModelComparisonBar";
import { ModelLibraryStats } from "../components/model-list/ModelLibraryStats";
import { ModelDetailView } from "../components/model-detail/ModelDetailView";
import { formatDelta, formatMetric, pickBestModel } from "../models/helpers";
import { formatRelativeTime } from "../training/helpers";
import { IconSearch } from "../components/training/icons";

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
  const [onnxDynamic, setOnnxDynamic] = useState(true);
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

  const submitOnnxExport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onnxTarget) return;
    const target = onnxTarget;
    void run(async () => {
      const exported = await api.exportModelOnnx(target.id, onnxDynamic);
      setOnnxTarget(undefined);
      await refresh();
      setDetailId(exported.id);
      setNotice(`已导出 ONNX：${exported.name}${onnxDynamic ? "（动态 batch）" : "（固定 batch）"}`);
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

  const submitOmConvert = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    if (!window.confirm(`删除模型 ${model.name}？`)) return;
    void run(async () => {
      await api.deleteModel(model.id);
      if (detailId === model.id) setDetailId(undefined);
      await refresh();
    });
  };

  const removeSelected = () => {
    if (!selectedIds.length) return;
    if (!window.confirm(`删除选中的 ${selectedIds.length} 个模型？`)) return;
    void run(async () => {
      for (const id of selectedIds) await api.deleteModel(id);
      setSelectedIds([]);
      setComparison(undefined);
      if (detailId && selectedIds.includes(detailId)) setDetailId(undefined);
      await refresh();
    });
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
        {onAskAgent ? <button type="button" className="button" onClick={() => onAskAgent(detailModel)}>询问智能体：此模型</button> : null}
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
            <span className="eyebrow">MODEL REGISTRY</span>
            <h1>模型库</h1>
          </div>
        </header>
        <div className="models-library-empty">
          <strong>暂无模型</strong>
          <p>完成训练后，best.pt 与 last.pt 会自动进入模型库，并可继续导出 ONNX / 转换 OM。</p>
        </div>
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

  return (
    <main className="models-layout models-workspace-page">
      <header className="models-page-header">
        <div className="models-page-header-main">
          <div>
            <span className="eyebrow">MODEL REGISTRY</span>
            <h1>模型库</h1>
            <p className="muted">按 数据集 → 版本 组织，每个版本下包含 PT / ONNX / OM 三类模型。</p>
          </div>
        </div>
        <div className="models-page-header-meta">
          <span className="models-chip"><strong>{tree.size} 个数据集</strong></span>
          <span className="models-chip models-chip--accent">{models.length} 个模型</span>
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
              <span className="eyebrow">MODEL COMPARISON</span>
              <h3>{comparison.candidate.name} vs {comparison.baseline.name}</h3>
            </div>
            <button type="button" className="button" onClick={() => setComparison(undefined)}>关闭</button>
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
          {comparison.suggestions[0] && <p className="muted">{comparison.suggestions[0]}</p>}
        </section>
      )}

      <nav className="models-crumb" aria-label="模型库导航">
        <button type="button" onClick={() => { setDrillDataset(undefined); setDrillVersion(undefined); }}>模型库</button>
        {drillDataset && (
          <>
            <span>›</span>
            <button type="button" onClick={() => setDrillVersion(undefined)}>{datasetName(drillDataset)}</button>
          </>
        )}
        {drillDataset && drillVersion !== undefined && (
          <>
            <span>›</span>
            <strong>{drillVersion != null ? `v${drillVersion}` : "未指定版本"}</strong>
          </>
        )}
      </nav>

      {drillDataset === undefined ? (
        <section className="models-library-section">
          <div className="models-library-toolbar">
            <div>
              <h2>数据集</h2>
              <p className="models-library-sub">选择数据集查看其各版本的模型</p>
            </div>
          </div>
          <div className="models-drill-list">
            {treeEntries.map(([datasetId, versions]) => {
              const total = [...versions.values()].reduce((sum, list) => sum + list.length, 0);
              return (
                <button
                  key={datasetId}
                  type="button"
                  className="models-drill-row"
                  onClick={() => { setDrillDataset(datasetId); setDrillVersion(undefined); }}
                >
                  <strong>{datasetName(datasetId)}</strong>
                  <small>{versions.size} 个版本 · {total} 个模型</small>
                  <em>›</em>
                </button>
              );
            })}
          </div>
        </section>
      ) : drillVersion === undefined ? (
        <section className="models-library-section">
          <div className="models-library-toolbar">
            <div>
              <h2>{datasetName(drillDataset)}</h2>
              <p className="models-library-sub">选择版本查看 PT / ONNX / OM 模型</p>
            </div>
          </div>
          <div className="models-drill-list">
            {versionKeysFor(drillDataset, tree.get(drillDataset) ?? new Map()).map((number) => {
              const meta = (versionLists[drillDataset] ?? []).find((version) => version.version_number === number);
              return (
                <button
                  key={number}
                  type="button"
                  className="models-drill-row"
                  onClick={() => setDrillVersion(number)}
                >
                  <strong>v{number}{meta?.is_active ? " · 当前激活" : ""}</strong>
                  <small>{tree.get(drillDataset)?.get(number)?.length ?? 0} 个模型{meta ? ` · ${meta.image_count} 张图` : ""}{meta?.note ? ` · ${meta.note}` : ""}</small>
                  <em>›</em>
                </button>
              );
            })}
            {(tree.get(drillDataset)?.has(null)) && (
              <button
                type="button"
                className="models-drill-row"
                onClick={() => setDrillVersion(null)}
              >
                <strong>未指定版本</strong>
                <small>{tree.get(drillDataset)?.get(null)?.length ?? 0} 个模型 · 训练时未锁定版本</small>
                <em>›</em>
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="models-library-section models-version-pane">
          <div className="models-library-toolbar">
            <div>
              <h2>{datasetName(drillDataset)} · {drillVersion != null ? `v${drillVersion}` : "未指定版本"}</h2>
              <p className="models-library-sub">{selectedModels.length} 个模型</p>
            </div>
            <div className="models-library-toolbar-actions">
              <label className="models-library-search">
                <IconSearch size={14} />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索模型名称 / 版本"
                />
              </label>
              <button
                type="button"
                className={`models-filter-toggle${includeArchived ? " active" : ""}`}
                onClick={() => setIncludeArchived((value) => !value)}
              >
                {includeArchived ? "含归档" : "仅启用"}
              </button>
            </div>
          </div>

          {FORMAT_SECTIONS.map(({ format, title, hint }) => {
            const list = selectedModels.filter((model) => model.format === format);
            return (
              <section key={format} className="models-format-section">
                <header>
                  <h3>{title}</h3>
                  <span className="muted">{list.length} 个</span>
                </header>
                {list.length ? (
                  <div className="model-table-wrap">
                    <table className="model-table">
                      <thead>
                        <tr>
                          {format === "pt" && <th className="model-table-check"></th>}
                          <th>名称</th>
                          <th>类型</th>
                          <th>mAP50</th>
                          <th>mAP50-95</th>
                          <th>Precision</th>
                          <th>Recall</th>
                          <th>状态</th>
                          <th>创建</th>
                          <th className="model-table-actions">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((model) => {
                          const selected = selectedIds.includes(model.id);
                          const generating = model.status === "converting";
                          return (
                            <tr key={model.id} className={`${selected ? "selected" : ""} ${model.status}`}>
                              {format === "pt" && (
                                <td className="model-table-check">
                                  <input type="checkbox" checked={selected} aria-label={`选择 ${model.name}`} onChange={() => setSelectedIds((ids) => ids.includes(model.id) ? ids.filter((item) => item !== model.id) : [...ids, model.id])} />
                                </td>
                              )}
                              <td className="model-table-name">
                                <button type="button" onClick={() => setDetailId(model.id)} title={model.name}>{model.name}</button>
                                <small>{model.version}</small>
                              </td>
                              <td>{model.artifact_type.toUpperCase()}</td>
                              <td className="model-table-metric">{formatMetric(model.map50)}</td>
                              <td className="model-table-metric">{formatMetric(model.map50_95)}</td>
                              <td className="model-table-metric">{formatMetric(model.precision)}</td>
                              <td className="model-table-metric">{formatMetric(model.recall)}</td>
                              <td><span className={`model-table-status ${model.status}`}>{modelStatusLabel(model.status)}</span></td>
                              <td className="model-table-time" title={model.created_at}>{formatRelativeTime(model.created_at)}</td>
                              <td className="model-table-actions">
                                {generating ? (
                                  <span className="muted">转换进行中…</span>
                                ) : (
                                  <>
                                    {model.format === "pt" ? (
                                      <>
                                        <button type="button" className="model-action-btn model-action-btn--primary" disabled={busy} onClick={() => setTesting(model)}>测试</button>
                                        <button type="button" className="model-action-btn model-action-btn--ghost" disabled={busy} onClick={() => { setOnnxTarget(model); setOnnxDynamic(true); }}>转ONNX</button>
                                      </>
                                    ) : null}
                                    {model.format === "onnx" ? (
                                      <button type="button" className="model-action-btn model-action-btn--ghost" disabled={busy} onClick={() => openOmConvert(model)}>转OM</button>
                                    ) : null}
                                    <button type="button" className="model-action-btn model-action-btn--ghost" disabled={busy} onClick={() => openFtpSave(model)}>转存FTP</button>
                                    <button type="button" className="model-action-btn model-action-btn--ghost" onClick={() => setDetailId(model.id)}>详情</button>
                                    <button type="button" className="model-action-btn model-action-btn--danger" disabled={busy} onClick={() => remove(model)}>删除</button>
                                  </>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted models-format-empty">{hint}</p>
                )}
              </section>
            );
          })}
        </section>
      )}

      {onnxTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOnnxTarget(undefined)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="onnx-export-title" onMouseDown={(event) => event.stopPropagation()}>
            <form onSubmit={submitOnnxExport}>
              <header>
                <div>
                  <span className="eyebrow">ONNX EXPORT</span>
                  <h2 id="onnx-export-title">导出 ONNX：{onnxTarget.name}</h2>
                  <p className="muted">FP32 ONNX，opset 18，自动化简；文件名与 PT 同名仅换后缀。</p>
                </div>
                <button type="button" className="icon-button" onClick={() => setOnnxTarget(undefined)} aria-label="关闭">×</button>
              </header>
              <label className="onnx-dynamic-row">
                <input type="checkbox" checked={onnxDynamic} onChange={(event) => setOnnxDynamic(event.target.checked)} />
                <span>动态尺寸（dynamic）</span>
                <small>勾选后 batch 维度动态，推理时可变 batch 输入；不勾选则固定为 1×3×640×640。</small>
              </label>
              <footer>
                <button type="button" className="button" onClick={() => setOnnxTarget(undefined)}>取消</button>
                <button type="submit" className="button primary" disabled={busy}>开始导出</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {ftpTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setFtpTarget(undefined)}>
          <section className="dataset-dialog ftp-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="ftp-save-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">SAVE TO FTP</span><h2 id="ftp-save-title">转存模型到 FTP</h2><p className="muted">浏览并选择目标目录，可修改保存文件名；同名文件将被覆盖。</p></div><button className="icon-button" onClick={() => setFtpTarget(undefined)} aria-label="关闭">×</button></header>
            <div className="ftp-picker">
              <div className="ftp-toolbar">
                <button className="button" disabled={ftpLoading || ftpPath === "/"} onClick={() => void loadFtpDirs(parentFtpPath(ftpPath))}>返回上级</button>
                <nav className="ftp-breadcrumb" aria-label="FTP 路径">
                  <button disabled={ftpLoading} onClick={() => void loadFtpDirs("/")}>/</button>
                  {ftpPath !== "/" && ftpPath.slice(1).split("/").map((crumb, index, parts) => {
                    const target = `/${parts.slice(0, index + 1).join("/")}`;
                    return <span key={target}>/ <button disabled={ftpLoading} onClick={() => void loadFtpDirs(target)}>{crumb}</button></span>;
                  })}
                </nav>
                <button className="button" disabled={ftpLoading} onClick={() => void loadFtpDirs(ftpPath)}>刷新</button>
              </div>
              <div className="ftp-picker-list">
                {ftpError ? <p className="annotation-form-error">{ftpError}</p> : null}
                {ftpLoading ? (
                  <p className="muted">正在读取目录…</p>
                ) : ftpEntries.length ? (
                  <table className="ftp-table">
                    <thead><tr><th>子目录</th></tr></thead>
                    <tbody>
                      {ftpEntries.map((entry) => (
                        <tr key={entry.path}>
                          <td>
                            <button className="ftp-name dir" onClick={() => void loadFtpDirs(entry.path)} title="打开目录">
                              <span aria-hidden="true">📁</span><span>{entry.name}</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">当前目录没有子目录，可直接保存到此处。</p>
                )}
              </div>
              <label className="ftp-save-name"><span>保存文件名</span>
                <input value={ftpFileName} onChange={(event) => setFtpFileName(event.target.value)} placeholder="例如：blade-detector_best.pt" />
              </label>
              <footer className="ftp-picker-actions">
                <span className="muted">目标目录：{ftpPath}</span>
                <div>
                  <button type="button" className="button" disabled={ftpBusy} onClick={() => setFtpTarget(undefined)}>取消</button>
                  <button type="button" className="button primary" disabled={ftpBusy || !ftpFileName.trim()} onClick={() => void submitFtpSave()}>{ftpBusy ? "转存中…" : "转存"}</button>
                </div>
              </footer>
            </div>
          </section>
        </div>
      )}

      {omTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOmTarget(undefined)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="om-convert-title" onMouseDown={(event) => event.stopPropagation()}>
            <form onSubmit={submitOmConvert}>
              <header>
                <div>
                  <span className="eyebrow">ATC CONVERT</span>
                  <h2 id="om-convert-title">转换为华为 OM：{omTarget.name}</h2>
                  <p className="muted">把该 ONNX 推到昇腾服务器的 agent 上执行 ATC 转换，完成后 .om 自动回传入库。</p>
                </div>
                <button type="button" className="icon-button" onClick={() => setOmTarget(undefined)} aria-label="关闭">×</button>
              </header>
              <label><span>转换节点</span>
                <select value={omNodeId} onChange={(event) => setOmNodeId(event.target.value)} disabled={!nodes.length}>
                  {!nodes.length && <option value="">暂无可用节点</option>}
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id} disabled={!node.enabled}>{node.name}（{node.url}）{node.enabled ? "" : " · 已禁用"}</option>
                  ))}
                </select>
              </label>
              <label><span>SoC 版本（soc_version）</span>
                <input value={omSocVersion} onChange={(event) => setOmSocVersion(event.target.value)} placeholder="Ascend310P3" />
              </label>
              <label><span>输入形状（input_shape）</span>
                <input value={omInputShape} onChange={(event) => setOmInputShape(event.target.value)} placeholder="images:1,3,640,640" />
              </label>
              <footer>
                <button type="button" className="button" onClick={() => setOmTarget(undefined)}>取消</button>
                <button type="submit" className="button primary" disabled={busy || !omNodeId}>开始转换</button>
              </footer>
            </form>
          </section>
        </div>
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
