import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AnnotationCanvas, type AnnotationDraft } from "./annotation/AnnotationCanvas";
import { api, apiUrl } from "./api/client";
import { StarterShell, type StarterSection } from "./components/StarterShell";
import { useLeaveConfirm } from "./components/useLeaveConfirm";
import { ConfirmProvider } from "./components/confirm";
import { TrainingView } from "./pages/TrainingView";
import { ModelsView } from "./pages/ModelsView";
import { SettingsView } from "./pages/SettingsView";
import { LogsView } from "./pages/LogsView";
import { FtpView } from "./pages/FtpView";
import { DataSourceView } from "./pages/DataSourceView";
import { sam3TranslateMessage } from "./pages/ClassTemplatesView";
import { AgentView, type AgentPageContext } from "./pages/AgentView";
import { PluginHostView } from "./components/plugins/PluginHostView";
import { PluginManagerView } from "./components/plugins/PluginManagerView";
import { AutoAnnotationModal } from "./components/AutoAnnotationModal";
import { ClassLibraryPicker } from "./components/ClassLibraryPicker";
import { ImportCenterModal } from "./components/ImportCenterModal";
import { DatasetVersionDialog } from "./components/DatasetVersionDialog";
import { Toast } from "./components/Toast";
import { readLocale, saveLocale, type AppLocale } from "./locale";
import type { Annotation, BBox, ClassLabel, Dataset, FtpEntry, DatasetQualityReport, DatasetVersion, DuplicateReport, ImageItem, ModelVersion, PluginMeta, SamCapabilities, SamPrediction, SourceDataset, SourceTag, SplitName, TaskType, ValidationReport } from "./types";

type View = "workspace" | "annotation" | "training" | "models" | "agent" | "settings-llm" | "settings-sam" | "settings-ftp" | "settings-nodes" | "settings-weights" | "settings-basedata" | "settings-webhook" | "settings-language" | "logs" | "ftp" | "datasources" | "plugin-manager" | "plugin";
type CardReportKind = "validation" | "quality" | "duplicates";
const ANNOTATION_IMAGE_PAGE_SIZE = 20;

function isHistoricalActive(dataset: Dataset): boolean {
  return dataset.active_version_number != null && dataset.latest_version_number != null && dataset.active_version_number !== dataset.latest_version_number;
}

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<Dataset>();
  const [classes, setClasses] = useState<ClassLabel[]>([]);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [selectedImage, setSelectedImage] = useState<ImageItem>();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [view, setView] = useState<View>("workspace");
  const [focusMode, setFocusMode] = useState(false);
  const [activeClassId, setActiveClassId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [samCapabilities, setSamCapabilities] = useState<SamCapabilities>();
  const [locale, setLocale] = useState<AppLocale>(() => readLocale());
  const [annotationDirty, setAnnotationDirty] = useState(false);
  const [focusTrainingTaskId, setFocusTrainingTaskId] = useState<string>();
  const [samBusy, setSamBusy] = useState(false);
  const [trainingCreateDatasetId, setTrainingCreateDatasetId] = useState<string>();
  const [focusModelId, setFocusModelId] = useState<string>();
  const [agentFocus, setAgentFocus] = useState<AgentPageContext>({});
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [activePluginId, setActivePluginId] = useState<string>();
  const { requestLeave, dialog: leaveDialog } = useLeaveConfirm(view === "annotation" && annotationDirty);

  const rejectReadOnly = (dataset: Dataset) => {
    if (!isHistoricalActive(dataset)) return false;
    setError(`数据集“${dataset.name}”当前激活的是历史版本 v${dataset.active_version_number}（最新 v${dataset.latest_version_number}），只读不可编辑。请新建版本或激活最新版本。`);
    return true;
  };

  const refreshDatasets = async () => {
    const result = await api.listDatasets();
    setDatasets(result);
    if (result.length > 0) setNotice("");
    if (selected) {
      const current = result.find((dataset) => dataset.id === selected.id);
      if (current) setSelected(current);
    }
  };

  const loadDataset = async (dataset: Dataset, nextView: View = "workspace") => {
    setNotice("");
    setSelected(dataset);
    setView(nextView);
    setSelectedImage(undefined);
    const [nextClasses, nextImages] = await Promise.all([api.listClasses(dataset.id), api.listImages(dataset.id)]);
    setClasses(nextClasses);
    setImages(nextImages.items);
    // A class id belongs to one dataset. Reusing the previous dataset's
    // active id leaves the annotation canvas without a valid label.
    setActiveClassId(nextClasses[0]?.id || "");
  };

  const createDatasetClass = async (name: string, color: string): Promise<ClassLabel | undefined> => {
    if (!selected) return undefined;
    if (rejectReadOnly(selected)) return undefined;
    const datasetId = selected.id;
    return runResult(async () => {
      const created = await api.createClass(datasetId, name, color);
      setClasses((items) => [...items, created].sort((left, right) => left.class_index - right.class_index));
      setSelected((current) => current?.id === datasetId ? { ...current, class_count: current.class_count + 1 } : current);
      setActiveClassId(created.id);
      setNotice(`已新增类别“${created.name}”`);
      return created;
    });
  };

  const importClassesFromLibrary = async (templateIds: string[]): Promise<ClassLabel[] | undefined> => {
    if (!selected) return undefined;
    if (rejectReadOnly(selected)) return undefined;
    const datasetId = selected.id;
    return runResult(async () => {
      const result = await api.importClasses(datasetId, templateIds);
      const next = await api.listClasses(datasetId);
      setClasses(next);
      setSelected((current) => current?.id === datasetId ? { ...current, class_count: next.length } : current);
      if (!activeClassId && next[0]) setActiveClassId(next[0].id);
      setNotice(
        result.skipped_names.length
          ? `已导入 ${result.imported.length} 个类别，同名跳过：${result.skipped_names.join("、")}`
          : `已导入 ${result.imported.length} 个类别`,
      );
      return result.imported;
    });
  };

  const updateDatasetClass = async (classId: string, payload: { sam3_prompt?: string; name?: string; color?: string }): Promise<ClassLabel | undefined> => {
    if (!selected) return undefined;
    if (rejectReadOnly(selected)) return undefined;
    const datasetId = selected.id;
    return runResult(async () => {
      const updated = await api.patchClass(datasetId, classId, payload);
      setClasses((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`类别“${updated.name}”已更新`);
      return updated;
    });
  };

  const deleteDatasetClass = async (classId: string): Promise<boolean | undefined> => {
    if (!selected) return undefined;
    if (rejectReadOnly(selected)) return undefined;
    const datasetId = selected.id;
    return runResult(async () => {
      const removed = classes.find((item) => item.id === classId);
      await api.deleteClass(datasetId, classId);
      // 后端删除后会重排剩余类别的 class_index，这里重新拉取保持一致。
      const next = await api.listClasses(datasetId);
      setClasses(next);
      setSelected((current) => current?.id === datasetId ? { ...current, class_count: next.length } : current);
      if (activeClassId === classId) setActiveClassId(next[0]?.id || "");
      setNotice(removed ? `类别“${removed.name}”已删除` : "类别已删除");
      return true;
    });
  };

  useEffect(() => {
    saveLocale(locale);
  }, [locale]);

  const refreshPlugins = () => {
    api.listPlugins().then((result) => setPlugins(result.items)).catch(() => undefined);
  };
  useEffect(refreshPlugins, []);

  // 有数据集在异步导入时轮询列表，并在完成/失败时提示结果。
  const importStatesRef = useRef<Record<string, string | null | undefined>>({});
  useEffect(() => {
    const states: Record<string, string | null | undefined> = {};
    for (const dataset of datasets) states[dataset.id] = dataset.import_state ?? null;
    const previous = importStatesRef.current;
    for (const dataset of datasets) {
      const before = previous[dataset.id];
      const now = states[dataset.id];
      if (before === "importing" && now === "completed") {
        setNotice(`「${dataset.name}」导入完成：${dataset.image_count} 张图片。`);
      } else if (before === "importing" && now === "failed") {
        setError(`「${dataset.name}」导入失败：${dataset.import_message ?? "未知错误"}`);
      } else if (before === "importing" && now === "stopped") {
        setNotice(`「${dataset.name}」已停止导入。`);
      } else if (before === "merging" && now == null) {
        setNotice(`「${dataset.name}」合并完成，图片与标注已入集。`);
      } else if (before === "merging" && now === "merge_failed") {
        setError(`「${dataset.name}」合并失败：${dataset.import_message ?? "未知错误"}`);
      } else if (before === "merging" && now === "merge_stopped") {
        setNotice(`「${dataset.name}」已停止合并，已合并部分保留。`);
      }
    }
    importStatesRef.current = states;
  }, [datasets]);

  const hasImportingDataset = datasets.some((dataset) => dataset.import_state === "importing" || dataset.import_state === "merging");
  useEffect(() => {
    if (!hasImportingDataset) return;
    const timer = window.setInterval(() => {
      api.listDatasets().then(setDatasets).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasImportingDataset]);

  useEffect(() => {
    refreshDatasets().catch((reason: unknown) => setError(errorMessage(reason)));
    api.getSystemInfo().then((info) => setSamCapabilities(info.sam)).catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  const runResult = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    setNotice("");
    try { return await action(); } catch (reason) { setError(errorMessage(reason)); return undefined; } finally { setBusy(false); }
  };

  const openImage = async (image: ImageItem, options?: { ignoreDirty?: boolean }) => {
    if (!selected) return;
    const proceed = () => void run(async () => {
      setSelectedImage(image);
      setAnnotations(await api.getAnnotations(selected.id, image.id));
      setView("annotation");
    });
    // 刚保存完时闭包里的 annotationDirty 还是旧值，由调用方声明跳过脏检查。
    if (!options?.ignoreDirty && view === "annotation" && annotationDirty) {
      requestLeave(() => {
        setAnnotationDirty(false);
        proceed();
      });
      return;
    }
    proceed();
  };

  const saveAnnotations = async (drafts: AnnotationDraft[]) => {
    if (!selected || !selectedImage) return false;
    if (rejectReadOnly(selected)) return false;
    let ok = false;
    await run(async () => {
      const saved = await api.replaceAnnotations(selected.id, selectedImage.id, drafts.map(({ id: _id, ...item }) => item));
      setAnnotations(saved);
      setImages((items) => items.map((item) => item.id === selectedImage.id ? { ...item, status: saved.length ? "annotated" : "unannotated" } : item));
      setAnnotationDirty(false);
      setNotice("标注已保存");
      ok = true;
    });
    return ok;
  };

  const continueAnnotation = async (dataset: Dataset) => {
    await run(async () => {
      await loadDataset(dataset);
      const nextImages = await api.listImages(dataset.id);
      const image = nextImages.items.find((item) => item.status === "unannotated") ?? nextImages.items[0];
      if (!image) {
        setNotice("该数据集还没有图片可标注。");
        return;
      }
      setSelectedImage(image);
      setAnnotations(await api.getAnnotations(dataset.id, image.id));
      setView("annotation");
    });
  };

  const displayedDataset = selected;
  const activePlugin = plugins.find((item) => item.id === activePluginId);
  const activeSection: StarterSection =
    view === "annotation"
      ? "workspace"
      : view === "settings-llm" || view === "settings-sam" || view === "settings-ftp" || view === "settings-nodes" || view === "settings-weights" || view === "settings-basedata" || view === "settings-webhook" || view === "settings-language"
        ? "settings"
        : view === "plugin"
          ? `plugin:${activePluginId ?? ""}`
          : view;
  const navigate = (section: StarterSection) => {
    const proceed = () => {
      setNotice("");
      setError("");
      if (section === "agent") setAgentFocus({});
      if (typeof section === "string" && section.startsWith("plugin:")) {
        setActivePluginId(section.slice("plugin:".length));
        setView("plugin");
        return;
      }
      if (section === "plugin-manager") {
        setView("plugin-manager");
        return;
      }
      // 训练与模型是全局入口：直接进入跨数据集的任务/模型列表，无数据集也可浏览。
      if (section === "training" || section === "models") {
        setView(section);
        return;
      }
      const globalSection = section === "settings" || section === "logs" || section === "agent" || section === "ftp" || section === "datasources";
      if (!globalSection && section !== "workspace" && !selected) {
        setNotice("请先创建或选择一个数据集。");
        return;
      }
      setView((section === "settings" ? "settings-llm" : section) as View);
    };
    if (view === "annotation" && annotationDirty) {
      requestLeave(() => {
        setAnnotationDirty(false);
        proceed();
      });
      return;
    }
    proceed();
  };

  const resolveDataset = async (datasetId: string): Promise<Dataset | undefined> => {
    const current = datasets.find((item) => item.id === datasetId) || selected;
    if (current?.id === datasetId) return current;
    const items = await api.listDatasets();
    setDatasets(items);
    return items.find((item) => item.id === datasetId);
  };

  const openAgentDataset = async (datasetId: string) => {
    await run(async () => {
      const dataset = await resolveDataset(datasetId);
      if (!dataset) {
        setError(`未找到数据集 ${datasetId}`);
        return;
      }
      await loadDataset(dataset, "workspace");
    });
  };

  const openAgentTrainingTask = async (datasetId: string | undefined, taskId: string) => {
    await run(async () => {
      let targetId = datasetId;
      if (!targetId) {
        const tasks = await api.listTrainingTasks();
        targetId = tasks.items.find((item) => item.id === taskId)?.dataset_id;
      }
      if (!targetId) {
        setError(`未找到训练任务 ${taskId} 所属数据集`);
        return;
      }
      const dataset = await resolveDataset(targetId);
      if (!dataset) {
        setError(`未找到数据集 ${targetId}`);
        return;
      }
      setFocusTrainingTaskId(taskId);
      await loadDataset(dataset, "training");
    });
  };

  const openAgentModel = async (datasetId: string | undefined, modelId: string) => {
    await run(async () => {
      let targetId = datasetId;
      if (!targetId) {
        const models = await api.listModels(undefined, true);
        targetId = models.items.find((item) => item.id === modelId)?.dataset_id || undefined;
      }
      if (!targetId) {
        setError(`未找到模型 ${modelId} 所属数据集`);
        return;
      }
      const dataset = await resolveDataset(targetId);
      if (!dataset) {
        setError(`未找到数据集 ${targetId}`);
        return;
      }
      setFocusModelId(modelId);
      await loadDataset(dataset, "models");
    });
  };

  return (
    <>
    <StarterShell active={activeSection} onNavigate={navigate} locale={locale} focusMode={view === "annotation" && focusMode} plugins={plugins}>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      {leaveDialog}
      {view === "annotation" && displayedDataset && selectedImage ? (
        <AnnotationView
          dataset={displayedDataset}
          image={selectedImage}
          images={images}
          onImageSelect={(image) => void openImage(image)}
          classes={classes}
          annotations={annotations}
          activeClassId={activeClassId}
          onClassChange={setActiveClassId}
          onBack={() => requestLeave(() => { setAnnotationDirty(false); setView("workspace"); })}
          onPrevious={() => { const index = images.findIndex((item) => item.id === selectedImage.id); if (index > 0) void openImage(images[index - 1]); }}
          onNext={async (drafts) => {
            const index = images.findIndex((item) => item.id === selectedImage.id);
            if (index < 0 || index >= images.length - 1) return;
            const target = images[index + 1];
            // 下一张自动保存未提交标注；保存失败停留在当前图片，避免丢失修改。
            if (annotationDirty) {
              if (!drafts) { void openImage(target); return; }
              if (!(await saveAnnotations(drafts))) return;
            }
            void openImage(target, { ignoreDirty: true });
          }}
          hasPrevious={images.findIndex((item) => item.id === selectedImage.id) > 0}
          hasNext={images.findIndex((item) => item.id === selectedImage.id) < images.length - 1}
          onDirtyChange={setAnnotationDirty}
          focusMode={focusMode}
          onToggleFocusMode={() => setFocusMode((value) => !value)}
          onSave={saveAnnotations}
          onCreateClass={createDatasetClass}
          onImportClasses={importClassesFromLibrary}
          onUpdateClass={updateDatasetClass}
          onDeleteClass={deleteDatasetClass}
          onSam={async (box) => {
            setSamBusy(true);
            setError("");
            try { return await api.samPredict({ image_id: selectedImage.id, class_id: activeClassId, prompt_type: "box", box }); }
            catch (reason) { setError(errorMessage(reason)); throw reason; }
            finally { setSamBusy(false); }
          }}
          onSamPoints={async (points) => {
            setSamBusy(true);
            setError("");
            try { return await api.samPredict({ image_id: selectedImage.id, class_id: activeClassId, prompt_type: "point", points: points.map(([x, y]) => ({ x, y, label: 1 })) }); }
            catch (reason) { setError(errorMessage(reason)); throw reason; }
            finally { setSamBusy(false); }
          }}
          busy={busy || samBusy}
          samBusy={samBusy}
          readOnly={!!displayedDataset && isHistoricalActive(displayedDataset)}
          samCapabilities={samCapabilities}
        />
      ) : view === "training" ? (
        <TrainingView
          datasets={datasets}
          dataset={selected}
          onDatasetChange={(dataset) => void loadDataset(dataset, "training")}
          onOpenModels={() => setView("models")}
          onAskAgent={(task) => { setAgentFocus({ dataset: { id: task.dataset_id, name: datasets.find((d) => d.id === task.dataset_id)?.name ?? task.dataset_id }, trainingTask: { id: task.id, name: task.name } }); setView("agent"); }}
          focusTaskId={focusTrainingTaskId}
          onFocusTaskConsumed={() => setFocusTrainingTaskId(undefined)}
          autoCreateDatasetId={trainingCreateDatasetId}
          onAutoCreateConsumed={() => setTrainingCreateDatasetId(undefined)}
        />
      ) : view === "models" ? (
        <ModelsView
          datasets={datasets}
          focusModelId={focusModelId}
          onFocusModelConsumed={() => setFocusModelId(undefined)}
          onAskAgent={(model) => { setAgentFocus({ ...(model.dataset_id ? { dataset: { id: model.dataset_id, name: datasets.find((d) => d.id === model.dataset_id)?.name ?? model.dataset_id } } : {}), model: { id: model.id, name: model.name } }); setView("agent"); }}
        />
      ) : view === "settings-llm" || view === "settings-sam" || view === "settings-ftp" || view === "settings-nodes" || view === "settings-weights" || view === "settings-basedata" || view === "settings-webhook" || view === "settings-language" ? (
        <SettingsView
          tab={view === "settings-llm" ? "llm" : view === "settings-sam" ? "sam" : view === "settings-ftp" ? "ftp" : view === "settings-nodes" ? "nodes" : view === "settings-weights" ? "weights" : view === "settings-basedata" ? "basedata" : view === "settings-webhook" ? "webhook" : "language"}
          locale={locale}
          onLocaleChange={setLocale}
          onTabChange={(tab) =>
            setView(tab === "llm" ? "settings-llm" : tab === "sam" ? "settings-sam" : tab === "ftp" ? "settings-ftp" : tab === "nodes" ? "settings-nodes" : tab === "weights" ? "settings-weights" : tab === "basedata" ? "settings-basedata" : tab === "webhook" ? "settings-webhook" : "settings-language")
          }
          onSamSettingsChange={() => {
            api.getSystemInfo().then((info) => setSamCapabilities(info.sam)).catch(() => undefined);
          }}
        />
      ) : view === "plugin-manager" ? (
        <PluginManagerView onChanged={refreshPlugins} />
      ) : view === "plugin" ? (
        activePlugin && <PluginHostView plugin={activePlugin} />
      ) : view === "ftp" ? (
        <FtpView />
      ) : view === "datasources" ? (
        <DataSourceView />
      ) : view === "logs" ? (
        <LogsView locale={locale} />
      ) : view === "agent" ? (
        <AgentView
          locale={locale}
          context={agentFocus}
          onOpenDataset={(datasetId) => void openAgentDataset(datasetId)}
          onOpenTrainingTask={(datasetId, taskId) => void openAgentTrainingTask(datasetId, taskId)}
          onOpenModel={(datasetId, modelId) => void openAgentModel(datasetId, modelId)}
        />
      ) : (
        <DatasetHome
          datasets={datasets}
          busy={busy}
          onCreate={(name, taskType, poseConfig, modelName) => run(async () => { const dataset = await api.createDataset(name, taskType, undefined, poseConfig, modelName); await refreshDatasets(); await loadDataset(dataset); setNotice("数据集已创建"); })}
          onClone={(datasetId, versionId, cloneName) => run(async () => {
            const result = versionId ? await api.cloneDatasetVersion(datasetId, versionId, cloneName) : await api.cloneDataset(datasetId, cloneName);
            await refreshDatasets();
            setNotice(`已克隆为“${result.dataset.name}”：复制 ${result.imported_images} 张图片、${result.imported_annotations} 条标注${result.skipped_images ? `，${result.skipped_images} 张因文件缺失被跳过` : ""}`);
          })}
          onImport={(file, name, taskType, format, modelName) => run(async () => { const result = format === "coco" ? await api.importCoco(file, name, taskType, false, modelName) : await api.importYolo(file, name, taskType, false, modelName); await refreshDatasets(); setNotice(`已开始导入「${result.dataset.name}」，进度见数据集列表。`); })}
          onFtpImport={(path, name, taskType, format, source, modelName) => run(async () => { const result = await api.importDatasetFromFtp({ path, name, ...(modelName ? { model_name: modelName } : {}), task_type: taskType, format, source }, false); await refreshDatasets(); setNotice(`已开始从 FTP ${source === "dir" ? "目录" : "压缩包"}导入「${result.dataset.name}」，进度见数据集列表。`); })}
          onCancelImport={(dataset) => run(async () => { await api.cancelDatasetImport(dataset.id); await refreshDatasets(); setNotice(`已请求停止「${dataset.name}」的导入。`); })}
          onQuality={(dataset) => runResult(() => api.qualityReport(dataset.id))}
          onAskAgent={(dataset) => { setAgentFocus({ dataset: { id: dataset.id, name: dataset.name } }); setView("agent"); }}
          agentLabel={locale === "zh" ? "询问助手" : "Ask assistant"}
          onAutoAnnotationComplete={() => void refreshDatasets()}
          onVersionsChange={() => void refreshDatasets()}
          onVideoImportComplete={(task) => run(async () => {
            await refreshDatasets();
            const dataset = task.dataset_id ? (await api.listDatasets()).find((item) => item.id === task.dataset_id) : undefined;
            if (dataset) await loadDataset(dataset);
            setNotice(`已从视频导入 ${task.generated_images} 张图片`);
          })}
          onContinueAnnotation={(dataset) => void continueAnnotation(dataset)}
          onUpload={(dataset, files, split) => run(async () => {
            const result = await api.uploadImages(dataset.id, files, split);
            await refreshDatasets();
            if (selected?.id === dataset.id) {
              const nextImages = await api.listImages(dataset.id);
              setImages(nextImages.items);
            }
            setNotice(`已添加 ${result.imported} 张图片到 ${split}`);
          })}
          onMergeYoloFromFtp={(dataset, path, source) => run(async () => {
            await api.mergeDatasetFromFtp(dataset.id, { path, source });
            await refreshDatasets();
            setNotice(`已开始从 FTP ${source === "dir" ? "目录" : "压缩包"}合并到「${dataset.name}」，进度见数据集列表。`);
          })}
          onMergeYolo={(dataset, file) => run(async () => {
            await api.mergeDatasetYoloZip(dataset.id, file);
            await refreshDatasets();
            if (selected?.id === dataset.id) {
              const nextImages = await api.listImages(dataset.id);
              setImages(nextImages.items);
              const nextClasses = await api.listClasses(dataset.id);
              setClasses(nextClasses);
            }
            setNotice(`已开始合并到「${dataset.name}」，进度见数据集列表。`);
          })}
          onSourceSync={(dataset, sourceDatasetId, tagIds, tagMatch, tagValues, split) => run(async () => {
            const result = await api.syncDatasetFromSource(dataset.id, { sourceDatasetId, tagIds, tagMatch, tagValues, split });
            await refreshDatasets();
            if (selected?.id === dataset.id) {
              const nextImages = await api.listImages(dataset.id);
              setImages(nextImages.items);
            }
            setNotice(`已从数据源同步 ${result.imported} 张图片${result.skipped ? `，跳过 ${result.skipped} 张` : ""}`);
          })}
          onTrain={(dataset) => void run(async () => { setTrainingCreateDatasetId(dataset.id); await loadDataset(dataset, "training"); })}
          onDuplicates={(dataset) => runResult(() => api.duplicateReport(dataset.id))}
          onDelete={(dataset) => run(async () => {
            await api.deleteDataset(dataset.id);
            setDatasets((items) => items.filter((item) => item.id !== dataset.id));
            if (selected?.id === dataset.id) {
              setSelected(undefined);
              setClasses([]);
              setImages([]);
              setSelectedImage(undefined);
              setAnnotations([]);
              setActiveClassId("");
            }
            setNotice(`数据集“${dataset.name}”已删除`);
          })}
        />
      )}
    </StarterShell>
      <ConfirmProvider />
    </>
  );
}

export function DatasetHome(props: {
  datasets: Dataset[];
  busy: boolean;
  onCreate: (name: string, type: TaskType, poseConfig?: { kpt_count: number; kpt_dim: number }, modelName?: string) => void;
  onClone: (datasetId: string, versionId: string | null, name: string) => void;
  onImport: (file: File, name: string, type: TaskType, format: "yolo" | "coco", modelName?: string) => void;
  onFtpImport: (path: string, name: string, type: TaskType, format: "yolo" | "coco", source: "zip" | "dir", modelName?: string) => void;
  onMergeYolo: (dataset: Dataset, file: File) => void;
  onMergeYoloFromFtp: (dataset: Dataset, path: string, source: "zip" | "dir") => void;
  onCancelImport: (dataset: Dataset) => void;
  onQuality: (dataset: Dataset) => Promise<DatasetQualityReport | undefined>;
  onAskAgent?: (dataset: Dataset) => void;
  agentLabel?: string;
  onAutoAnnotationComplete?: () => void;
  onVideoImportComplete?: (task: import("./types").VideoImportTask) => Promise<void> | void;
  onContinueAnnotation: (dataset: Dataset) => void;
  onUpload: (dataset: Dataset, files: File[], split: SplitName) => void;
  onSourceSync: (dataset: Dataset, sourceDatasetId: string, tagIds: string[], tagMatch: "all" | "any", tagValues: Record<string, string>, split: SplitName) => void;
  onTrain: (dataset: Dataset) => void;
  onDuplicates: (dataset: Dataset) => Promise<DuplicateReport | undefined>;
  onDelete: (dataset: Dataset) => void;
  onVersionsChange?: () => void;
}) {
  const [dialog, setDialog] = useState<"create" | "import" | null>(null);
  const [exportTarget, setExportTarget] = useState<Dataset>();
  const [exportFormat, setExportFormat] = useState<"yolo" | "coco">("yolo");
  const [deleteTarget, setDeleteTarget] = useState<Dataset>();
  const [uploadTarget, setUploadTarget] = useState<Dataset>();
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadSplit, setUploadSplit] = useState<SplitName>("train");
  const [uploadMode, setUploadMode] = useState<"local" | "zip" | "source">("local");
  const [zipFile, setZipFile] = useState<File>();
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [zipOrigin, setZipOrigin] = useState<"local" | "ftp">("local");
  const [zipFtpPath, setZipFtpPath] = useState("/");
  const [zipFtpEntries, setZipFtpEntries] = useState<FtpEntry[]>();
  const [zipFtpError, setZipFtpError] = useState("");
  const [zipFtpLoading, setZipFtpLoading] = useState(false);
  const [zipFtpSelected, setZipFtpSelected] = useState("");
  const [zipFtpKind, setZipFtpKind] = useState<"zip" | "dir">("zip");

  const browseZipFtp = (path: string) => {
    setZipFtpLoading(true);
    setZipFtpError("");
    return api.listFtp(path).then((result) => {
      setZipFtpPath(result.path);
      setZipFtpEntries(result.entries);
    }).catch((reason) => {
      setZipFtpEntries(undefined);
      setZipFtpError(reason instanceof Error ? reason.message : "无法读取 FTP 目录。");
    }).finally(() => setZipFtpLoading(false));
  };
  const zipFtpParent = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    return index <= 0 ? "/" : trimmed.slice(0, index);
  };
  const [sourceDatasets, setSourceDatasets] = useState<SourceDataset[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [sourceTags, setSourceTags] = useState<SourceTag[]>([]);
  const [sourceTagIds, setSourceTagIds] = useState<string[]>([]);
  const [sourceTagValues, setSourceTagValues] = useState<Record<string, string>>({});
  const [sourceTagMatch, setSourceTagMatch] = useState<"all" | "any">("all");
  const [sourceTotal, setSourceTotal] = useState<number>();
  const [sourceLoading, setSourceLoading] = useState(false);
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("detect");
  const [kptCount, setKptCount] = useState("4");
  const [kptDim, setKptDim] = useState("3");
  const [createMode, setCreateMode] = useState<"blank" | "clone">("blank");
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [cloneVersions, setCloneVersions] = useState<DatasetVersion[] | null>(null);
  const [cloneVersionId, setCloneVersionId] = useState("");
  const [cloneLoading, setCloneLoading] = useState(false);
  const [qualityReports, setQualityReports] = useState<Record<string, DatasetQualityReport>>({});
  const [duplicateReports, setDuplicateReports] = useState<Record<string, DuplicateReport>>({});
  const [expandedReports, setExpandedReports] = useState<Record<string, CardReportKind | undefined>>({});
  const uploadFileRef = useRef<HTMLInputElement>(null);
  const [draggingImages, setDraggingImages] = useState(false);
  const [autoAnnotationTarget, setAutoAnnotationTarget] = useState<Dataset>();
  const [versionTarget, setVersionTarget] = useState<Dataset>();
  const [renameTarget, setRenameTarget] = useState<Dataset>();
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [createModelName, setCreateModelName] = useState("");
  const [renameModelName, setRenameModelName] = useState("");
  const [dialogError, setDialogError] = useState("");
  const toggleQuality = async (dataset: Dataset) => {
    if (isReportOpen(dataset.id, "quality")) return closeReport(dataset.id);
    if (qualityReports[dataset.id]) return openReport(dataset.id, "quality");
    const report = await props.onQuality(dataset);
    if (report) { setQualityReports((items) => ({ ...items, [dataset.id]: report })); openReport(dataset.id, "quality"); }
  };
  const toggleDuplicates = async (dataset: Dataset) => {
    if (isReportOpen(dataset.id, "duplicates")) return closeReport(dataset.id);
    if (duplicateReports[dataset.id]) return openReport(dataset.id, "duplicates");
    const report = await props.onDuplicates(dataset);
    if (report) { setDuplicateReports((items) => ({ ...items, [dataset.id]: report })); openReport(dataset.id, "duplicates"); }
  };

  const openBasicInfo = (dataset: Dataset) => {
    setRenameTarget(dataset);
    setRenameName(dataset.name);
    setRenameModelName(dataset.model_name ?? "");
    setDialogError("");
  };

  const submitBasicInfo = async () => {
    if (!renameTarget || !renameName.trim()) return;
    setRenameBusy(true);
    setDialogError("");
    try {
      await api.updateDataset(renameTarget.id, { name: renameName.trim(), model_name: renameModelName.trim() || null });
      setRenameTarget(undefined);
      props.onVersionsChange?.();
    } catch (reason) {
      setDialogError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setRenameBusy(false);
    }
  };

  const cloneSource = props.datasets.find((item) => item.id === cloneSourceId);
  const cloneSourceHasVersions = cloneSource != null && cloneSource.latest_version_number != null;

  useEffect(() => {
    if (createMode !== "clone" || !cloneSourceId) return;
    if (!cloneSourceHasVersions) {
      setCloneVersions([]);
      setCloneVersionId("");
      setCloneLoading(false);
      if (cloneSource) setName(`${cloneSource.name}-副本`);
      return;
    }
    let cancelled = false;
    setCloneLoading(true);
    api.listDatasetVersions(cloneSourceId)
      .then((items) => {
        if (cancelled) return;
        setCloneVersions(items);
        const latest = items[0];
        if (latest && cloneSource) setName(`${cloneSource.name}-v${latest.version_number}`);
        setCloneVersionId(latest?.id ?? "");
      })
      .catch(() => { if (!cancelled) setCloneVersions([]); })
      .finally(() => { if (!cancelled) setCloneLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createMode, cloneSourceId]);

  const closeDialog = () => {
    setDialog(null);
    setName("");
    setTaskType("detect");
    setKptCount("4");
    setKptDim("3");
    setCreateMode("blank");
    setCloneSourceId("");
    setCloneVersions(null);
    setCloneVersionId("");
  };
  const create = () => {
    if (!name.trim()) return;
    if (createMode === "clone") {
      if (!cloneSourceId || (cloneSourceHasVersions && !cloneVersionId)) return;
      props.onClone(cloneSourceId, cloneSourceHasVersions ? cloneVersionId : null, name.trim());
    } else if (taskType === "pose") {
      const count = Number(kptCount);
      const dim = Number(kptDim);
      if (!Number.isInteger(count) || count < 1 || count > 133 || (dim !== 2 && dim !== 3)) return;
      props.onCreate(name.trim(), taskType, { kpt_count: count, kpt_dim: dim }, createModelName.trim() || undefined);
    } else {
      props.onCreate(name.trim(), taskType, undefined, createModelName.trim() || undefined);
    }
    closeDialog();
  };
  const closeUpload = () => {
    setUploadTarget(undefined);
    setUploadFiles([]);
    setUploadSplit("train");
    setDraggingImages(false);
    setUploadMode("local");
    setSourceTagIds([]);
    setSourceTagMatch("all");
    setSourceTotal(undefined);
  };
  const chooseImages = (files?: FileList | File[]) => {
    if (files) setUploadFiles(Array.from(files));
  };
  const startUpload = () => {
    if (!uploadTarget || !uploadFiles.length) return;
    props.onUpload(uploadTarget, uploadFiles, uploadSplit);
    closeUpload();
  };
  const startZipMerge = () => {
    if (!uploadTarget) return;
    if (zipOrigin === "ftp") {
      if (!zipFtpSelected) return;
      props.onMergeYoloFromFtp(uploadTarget, zipFtpSelected, zipFtpKind);
    } else {
      if (!zipFile) return;
      props.onMergeYolo(uploadTarget, zipFile);
    }
    closeUpload();
  };
  const openSourceMode = async () => {
    setUploadMode("source");
    if (sourceDatasets.length) return;
    setSourceLoading(true);
    try {
      const list = await api.listSourceDatasets();
      setSourceDatasets(list);
      setSourceId(list[0]?.id ?? "");
    } catch {
      setSourceDatasets([]);
    } finally {
      setSourceLoading(false);
    }
  };
  const startSourceSync = () => {
    if (!uploadTarget || !sourceId) return;
    props.onSourceSync(uploadTarget, sourceId, sourceTagIds, sourceTagMatch, sourceTagValues, uploadSplit);
    closeUpload();
  };
  const openExport = (dataset: Dataset) => {
    setExportTarget(dataset);
    setExportFormat("yolo");
  };
  const exportUrl = exportTarget && (exportFormat === "coco" ? api.exportCocoUrl(exportTarget.id) : api.exportYoloUrl(exportTarget.id));
  const isReportOpen = (datasetId: string, kind: CardReportKind) => expandedReports[datasetId] === kind;
  const closeReport = (datasetId: string) => setExpandedReports((items) => ({ ...items, [datasetId]: undefined }));
  const openReport = (datasetId: string, kind: CardReportKind) => setExpandedReports((items) => ({ ...items, [datasetId]: kind }));
  useEffect(() => {
    if (uploadMode !== "source" || !sourceId) return;
    let cancelled = false;
    setSourceLoading(true);
    api.listSourceTags(sourceId)
      .then((tags) => { if (!cancelled) { setSourceTags(tags); setSourceTagIds([]); } })
      .catch(() => { if (!cancelled) setSourceTags([]); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [uploadMode, sourceId]);

  useEffect(() => {
    if (uploadMode !== "source" || !sourceId) return;
    let cancelled = false;
    setSourceLoading(true);
    api.listSourceImages(sourceId, { tagIds: sourceTagIds.length ? sourceTagIds : undefined, tagValues: sourceTagValues, tagMatch: sourceTagMatch, limit: 1 })
      .then((page) => { if (!cancelled) setSourceTotal(page.total); })
      .catch(() => { if (!cancelled) setSourceTotal(undefined); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [uploadMode, sourceId, sourceTagIds, sourceTagValues, sourceTagMatch]);

  return <main className="dataset-home-page">
    <header className="dataset-home-header">
      <div><h1>数据集</h1><p>在这里创建、导入和管理你的数据集。</p></div>
      <div className="header-actions"><button className="button" onClick={() => setDialog("import")}>导入数据</button><button className="button primary" onClick={() => setDialog("create")}>新建数据集</button></div>
    </header>
    <section className="dataset-overview">
      <div className="section-title-row"><div><span className="eyebrow">ALL DATASETS</span><h2>所有数据集</h2></div><span className="dataset-total">{props.datasets.length} 个数据集</span></div>
      <div className="dataset-grid">
        {props.datasets.map((dataset, index) => { const importing = dataset.import_state === "importing"; const merging = dataset.import_state === "merging"; const failedImport = dataset.import_state === "failed" || dataset.import_state === "stopped"; const mergeIssue = dataset.import_state === "merge_failed" || dataset.import_state === "merge_stopped"; const importBlocked = importing || merging || failedImport; return <article key={dataset.id} className="dataset-card">
          <header><span className={`dataset-icon tone-${index % 3}`}>{dataset.task_type === "segment" || dataset.task_type === "obb" ? "◇" : dataset.task_type === "classify" ? "○" : dataset.task_type === "pose" ? "✥" : "□"}</span><div><h2>{dataset.name}</h2><small>{taskDescription(dataset.task_type)}{dataset.task_type === "pose" && dataset.pose_config ? ` · ${dataset.pose_config.kpt_count} 关键点` : ""}</small></div><div className="dataset-card-header-actions"><span className={`status ${dataset.import_state === "failed" || dataset.import_state === "merge_failed" ? "failed" : dataset.import_state === "stopped" || dataset.import_state === "merge_stopped" ? "stopped" : importing || merging ? "" : "ready"}`}>{merging ? "合并中" : importing ? "导入中" : dataset.import_state === "failed" ? "导入失败" : dataset.import_state === "stopped" ? "已停止" : dataset.import_state === "merge_failed" ? "合并失败" : dataset.import_state === "merge_stopped" ? "已停止" : "就绪"}</span></div></header>
          {(importing || merging) && <div className="dataset-import-progress" role="status"><div className="dataset-import-progress-top"><span>{dataset.import_message ?? "正在导入…"}</span><span>{Math.round(dataset.import_progress ?? 0)}%</span></div><div className="progress-track"><i style={{ width: `${Math.min(100, Math.max(2, dataset.import_progress ?? 0))}%` }} /></div></div>}
          {dataset.import_state === "failed" && <div className="validation invalid"><span>导入失败：{dataset.import_message ?? "未知错误"}</span></div>}
          {dataset.import_state === "merge_failed" && <div className="validation invalid"><span>合并失败：{dataset.import_message ?? "未知错误"}</span><small>数据集仍可正常使用；重新上传压缩包会跳过已合并的同名图片。</small></div>}
          {dataset.import_state === "merge_stopped" && <div className="validation valid"><span>合并已停止：已合并部分保留，可重新上传继续。</span></div>}
          <div className="dataset-metrics"><span><small>图片</small><strong>{dataset.image_count.toLocaleString()}</strong></span><span><small>类别</small><strong>{dataset.class_count.toLocaleString()}</strong></span></div>
          <div className="dataset-version-line">
            {dataset.latest_version_number ? <><span>版本</span><strong>v{dataset.latest_version_number}</strong>{dataset.active_version_number != null && dataset.active_version_number !== dataset.latest_version_number && <em>只读 · 已激活 v{dataset.active_version_number}（非最新）</em>}</> : <span className="muted">未创建版本</span>}
          </div>
          <div className="dataset-progress"><span>标注进度</span><strong>{dataset.image_count ? `${Math.round(dataset.annotated_image_count / dataset.image_count * 100)}%` : "等待导入"}</strong></div>
          <div className="progress-track"><i style={{ width: `${dataset.image_count ? dataset.annotated_image_count / dataset.image_count * 100 : 0}%` }} /></div>
          {!importBlocked && <button className="button primary dataset-primary-action" disabled={props.busy || importing || !dataset.image_count} onClick={() => props.onContinueAnnotation(dataset)}>继续标注</button>}
          <div className="dataset-card-actions">
            {importing || merging ? <button className="button danger" disabled={props.busy} onClick={() => props.onCancelImport?.(dataset)}>{importing ? "停止导入" : "停止合并"}</button> : failedImport ? <button className="button dataset-delete-action" disabled={props.busy} onClick={() => setDeleteTarget(dataset)}>删除</button> : <>
            {props.onAskAgent ? <button className="button" disabled={props.busy || importing} onClick={() => props.onAskAgent?.(dataset)}>{props.agentLabel ?? "询问助手"}</button> : null}
            <button className="button" disabled={props.busy || importing || isHistoricalActive(dataset)} onClick={() => setUploadTarget(dataset)}>添加图片</button>
            <button className="button" disabled={props.busy || importing} onClick={() => openBasicInfo(dataset)}>基础信息维护</button>
            <button className="button" disabled={props.busy || importing} onClick={() => props.onTrain(dataset)}>训练</button>
            <button className="button dataset-auto-annotation-action" disabled={props.busy || importing || !dataset.image_count || isHistoricalActive(dataset)} onClick={() => setAutoAnnotationTarget(dataset)}>自动标注</button>
            <button className="button" disabled={props.busy || importing || !dataset.image_count} onClick={() => openExport(dataset)}>导出数据</button>
            <button className="button" disabled={props.busy || importing || !dataset.image_count} onClick={() => void toggleDuplicates(dataset)}>{isReportOpen(dataset.id, "duplicates") ? "收起重复图" : "重复/相似图"}</button>
            <button className="button" disabled={props.busy || importing} onClick={() => void toggleQuality(dataset)}>{isReportOpen(dataset.id, "quality") ? "收起报告" : "质量报告"}</button>
            <button className="button" disabled={props.busy || importing} onClick={() => setVersionTarget(dataset)}>版本管理</button>
            <button className="button dataset-delete-action" disabled={props.busy} onClick={() => setDeleteTarget(dataset)}>删除</button>
            </>}
          </div>
          {isReportOpen(dataset.id, "quality") && qualityReports[dataset.id] && <CardReport onClose={() => closeReport(dataset.id)}><QualityPanel report={qualityReports[dataset.id]} compact /></CardReport>}
          {isReportOpen(dataset.id, "duplicates") && duplicateReports[dataset.id] && <CardReport onClose={() => closeReport(dataset.id)}><DuplicatePanel report={duplicateReports[dataset.id]} compact /></CardReport>}
        </article>; })}
        {!props.datasets.length && <section className="dataset-empty-card"><span className="dataset-empty-icon">□</span><h2>还没有数据集</h2><p>新建一个空数据集，或导入已有的 YOLO ZIP 数据集。</p><div><button className="button" onClick={() => setDialog("import")}>导入数据</button><button className="button primary" onClick={() => setDialog("create")}>新建数据集</button></div></section>}
      </div>
    </section>
    {autoAnnotationTarget && <AutoAnnotationModal dataset={autoAnnotationTarget} onClose={() => setAutoAnnotationTarget(undefined)} onChanged={() => props.onAutoAnnotationComplete?.()} />}
    {dialog === "import" && <ImportCenterModal busy={props.busy} onClose={closeDialog} onArchiveImport={props.onImport} onFtpImport={props.onFtpImport} onVideoCompleted={(task) => props.onVideoImportComplete?.(task)} />}
    {dialog === "create" && <div className="modal-backdrop data-exchange-backdrop" role="presentation" onMouseDown={closeDialog}>
      <section className="dataset-dialog data-exchange-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="data-exchange-header"><div><span className="eyebrow">NEW DATASET</span><h2 id="dataset-dialog-title">新建数据集</h2><p>创建空白数据集，或从现有数据集的某个版本克隆。</p></div><button className="icon-button" onClick={closeDialog} aria-label="关闭">×</button></header>
        <div className="upload-mode-switch" role="tablist" aria-label="创建方式">
          <button role="tab" aria-selected={createMode === "blank"} className={createMode === "blank" ? "active" : ""} onClick={() => setCreateMode("blank")}>创建空白数据集</button>
          <button role="tab" aria-selected={createMode === "clone"} className={createMode === "clone" ? "active" : ""} onClick={() => { setCreateMode("clone"); if (!cloneSourceId && props.datasets[0]) setCloneSourceId(props.datasets[0].id); }}>从现有版本克隆</button>
        </div>
        {createMode === "blank" ? (
          <div className="exchange-fields"><label>数据集名称<input value={name} placeholder="例如：my-dataset" onChange={(event) => setName(event.target.value)} autoFocus /></label><label>产出模型名称（选填）<input value={createModelName} placeholder="例如：blade-detector；训练产出的模型默认用此命名" onChange={(event) => setCreateModelName(event.target.value)} /></label><label>任务类型<select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)}><option value="detect">目标检测（Bounding Box）</option><option value="segment">实例分割（Polygon / SAM）</option><option value="obb">旋转框（OBB）</option><option value="classify">图像分类</option><option value="pose">关键点检测（Pose）</option></select></label>{taskType === "pose" && <><label>关键点数量<input type="number" min={1} max={133} value={kptCount} onChange={(event) => setKptCount(event.target.value)} /></label><label>关键点维度<select value={kptDim} onChange={(event) => setKptDim(event.target.value)}><option value="3">x, y, 可见性（推荐）</option><option value="2">x, y</option></select></label></>}</div>
        ) : (
          <>
            <div className="exchange-fields">
              <label>源数据集<select value={cloneSourceId} disabled={!props.datasets.length || cloneLoading} onChange={(event) => { setCloneSourceId(event.target.value); setCloneVersionId(""); }}>{props.datasets.map((item) => <option key={item.id} value={item.id}>{item.name}{item.latest_version_number != null ? `（最新 v${item.latest_version_number}）` : "（未创建版本，克隆当前工作区）"}</option>)}</select></label>
              {cloneSourceHasVersions && <label>版本<select value={cloneVersionId} disabled={cloneLoading || !cloneVersions?.length} onChange={(event) => { const version = cloneVersions?.find((item) => item.id === event.target.value); setCloneVersionId(event.target.value); if (version && cloneSource) setName(`${cloneSource.name}-v${version.version_number}`); }}>{cloneVersions?.map((version) => <option key={version.id} value={version.id}>v{version.version_number}{version.note ? ` · ${version.note}` : ""} · {version.image_count} 张图片</option>)}</select></label>}
              <label>新数据集名称<input value={name} placeholder="例如：my-dataset-v1" onChange={(event) => setName(event.target.value)} /></label>
            </div>
            {!props.datasets.length ? <p className="muted">还没有可克隆的数据集，先创建或导入一个。</p> : cloneLoading ? <p className="muted">正在加载版本…</p> : !cloneSourceHasVersions ? <p className="muted">该数据集还没有版本，将克隆其当前工作区（图片、类别与标注的实时状态）。</p> : null}
          </>
        )}
        <footer className="data-exchange-footer"><span>{createMode === "clone" ? "任务类型与类别会沿用源数据集。" : taskType === "pose" ? "pose 数据集的关键点数量创建后不可修改，导出训练时会写入 kpt_shape。" : "创建后可从卡片继续导入图片或已有数据。"}</span><div><button className="button" onClick={closeDialog}>取消</button><button className="button primary" disabled={props.busy || !name.trim() || (createMode === "blank" && taskType === "pose" && !(Number(kptCount) >= 1 && Number(kptCount) <= 133)) || (createMode === "clone" && (!cloneSourceId || (cloneSourceHasVersions && !cloneVersionId)))} onClick={create}>{createMode === "clone" ? "克隆数据集" : "创建数据集"}</button></div></footer>
      </section>
    </div>}
    {uploadTarget && <div className="modal-backdrop data-exchange-backdrop" role="presentation" onMouseDown={closeUpload}>
      <section className="dataset-dialog data-exchange-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-upload-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="data-exchange-header"><div><span className="eyebrow">ADD IMAGES</span><h2 id="dataset-upload-dialog-title">添加图片到“{uploadTarget.name}”</h2><p>从本地上传或数据源同步，图片会复制进当前数据集。</p></div><button className="icon-button" onClick={closeUpload} aria-label="关闭">×</button></header>
        <div className="upload-mode-switch" role="tablist" aria-label="图片来源">
          <button role="tab" aria-selected={uploadMode === "local"} className={uploadMode === "local" ? "active" : ""} onClick={() => setUploadMode("local")}>本地上传</button>
          <button role="tab" aria-selected={uploadMode === "zip"} className={uploadMode === "zip" ? "active" : ""} onClick={() => setUploadMode("zip")}>YOLO 压缩包</button>
          <button role="tab" aria-selected={uploadMode === "source"} className={uploadMode === "source" ? "active" : ""} onClick={() => void openSourceMode()}>从数据源同步</button>
        </div>
        {uploadMode === "local" ? <>
          <div className="upload-options"><label>导入到 split<select value={uploadSplit} onChange={(event) => setUploadSplit(event.target.value as SplitName)}><option value="train">train · 训练集</option><option value="val">val · 验证集</option><option value="test">test · 测试集</option></select></label></div>
          <input ref={uploadFileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { chooseImages(event.target.files ?? undefined); event.currentTarget.value = ""; }} />
          <button className={draggingImages ? "exchange-dropzone dragging" : "exchange-dropzone"} onClick={() => uploadFileRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDraggingImages(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDraggingImages(false)} onDrop={(event) => { event.preventDefault(); setDraggingImages(false); chooseImages(event.dataTransfer.files); }}><span className="exchange-dropzone-icon">⇧</span><strong>{uploadFiles.length ? `已选择 ${uploadFiles.length} 张图片` : "拖放或选择图片"}</strong><small>{uploadFiles.length ? uploadFiles.slice(0, 3).map((file) => file.name).join("、") + (uploadFiles.length > 3 ? ` 等 ${uploadFiles.length} 张` : "") : "支持 JPG、PNG、WEBP 等常见图片格式，可多选"}</small></button>
          <footer className="data-exchange-footer"><span>原图会复制到受管数据目录，现有标注不会受影响。</span><div><button className="button" onClick={closeUpload}>取消</button><button className="button primary" disabled={props.busy || !uploadFiles.length} onClick={startUpload}>添加 {uploadFiles.length || ""} 张图片</button></div></footer>
        </> : uploadMode === "zip" ? <>
          <div className="import-origin-toggle" role="group" aria-label="合并来源" style={{ margin: "0 28px" }}>
            <button type="button" className={zipOrigin === "local" ? "active" : ""} onClick={() => { setZipOrigin("local"); setZipFtpSelected(""); }}>本地上传</button>
            <button type="button" className={zipOrigin === "ftp" ? "active" : ""} onClick={() => { setZipOrigin("ftp"); if (zipFtpEntries === undefined && !zipFtpLoading && !zipFtpError) void browseZipFtp(zipFtpPath); }}>FTP 选择</button>
          </div>
          {zipOrigin === "local" ? <>
            <input ref={zipInputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { setZipFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            <button type="button" className="exchange-dropzone" onClick={() => zipInputRef.current?.click()}><span className="exchange-dropzone-icon">⇧</span><strong>{zipFile?.name ?? "选择标准 YOLO 数据集 ZIP"}</strong><small>{zipFile ? `${Math.ceil(zipFile.size / 1024 / 1024)} MB · 已准备合并` : "ZIP 内应包含 images 与 labels（可带 data.yaml）；类别按名称合并，同名图片跳过"}</small></button>
          </> : (
            <div className="import-ftp-picker">
              <div className="import-ftp-toolbar">
                <button type="button" className="button" disabled={zipFtpLoading || zipFtpPath === "/"} onClick={() => void browseZipFtp(zipFtpParent(zipFtpPath))}>↑ 上级</button>
                <input value={zipFtpPath} aria-label="FTP 路径" onChange={(event) => setZipFtpPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void browseZipFtp(zipFtpPath); }} />
                <button type="button" className="button" disabled={zipFtpLoading} onClick={() => void browseZipFtp(zipFtpPath)}>浏览</button>
                <div className="import-origin-toggle" role="group" aria-label="FTP 来源类型">
                  <button type="button" className={zipFtpKind === "zip" ? "active" : ""} onClick={() => { setZipFtpKind("zip"); setZipFtpSelected(""); }}>ZIP 文件</button>
                  <button type="button" className={zipFtpKind === "dir" ? "active" : ""} onClick={() => { setZipFtpKind("dir"); setZipFtpSelected(""); }}>YOLO 目录</button>
                </div>
              </div>
              <div className="import-ftp-list">
                {zipFtpLoading && <p className="muted">正在读取目录…</p>}
                {zipFtpError && <p className="annotation-form-error">{zipFtpError}（请先在「FTP 管理」页配置连接）</p>}
                {!zipFtpLoading && !zipFtpError && zipFtpEntries?.map((entry) => entry.is_dir
                  ? <button key={entry.name} type="button" className="import-ftp-row dir" onClick={() => void browseZipFtp(`${zipFtpPath.replace(/\/+$/, "")}/${entry.name}`)}><span>📁</span><strong>{entry.name}</strong><small>目录</small></button>
                  : <button key={entry.name} type="button" disabled={!entry.name.toLowerCase().endsWith(".zip")} className={`import-ftp-row file${zipFtpSelected === `${zipFtpPath.replace(/\/+$/, "")}/${entry.name}` ? " selected" : ""}`} onClick={() => setZipFtpSelected(`${zipFtpPath.replace(/\/+$/, "")}/${entry.name}`)}><span>🗜</span><strong>{entry.name}</strong><small>{entry.size != null ? `${Math.ceil(entry.size / 1024)} KB` : ""}</small></button>)}
                {zipFtpKind === "dir" && !zipFtpLoading && !zipFtpError && <button type="button" className={`import-ftp-row dir${zipFtpSelected === zipFtpPath ? " selected" : ""}`} onClick={() => setZipFtpSelected(zipFtpPath)}><span>📁</span><strong>合并当前目录：{zipFtpPath}</strong><small>递归收集 images / labels / data.yaml</small></button>}
                {zipFtpSelected && <p className="import-ftp-selected">已选择：{zipFtpSelected}</p>}
              </div>
            </div>
          )}
          <footer className="data-exchange-footer"><span>图片与标注会追加到当前数据集；压缩包/目录内 train/val/test 决定 split。</span><div><button className="button" onClick={closeUpload}>取消</button><button className="button primary" disabled={props.busy || (zipOrigin === "local" ? !zipFile : !zipFtpSelected)} onClick={startZipMerge}>开始合并</button></div></footer>
        </> : <>
          <div className="exchange-fields"><label>选择数据源<select value={sourceId} disabled={!sourceDatasets.length} onChange={(event) => setSourceId(event.target.value)}>{sourceDatasets.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.image_count} 张）</option>)}</select></label></div>
          {!sourceDatasets.length && <p className="muted">{sourceLoading ? "正在加载数据源…" : "还没有数据源，可先在“数据源”页创建并导入图片。"}</p>}
          {sourceDatasets.length > 0 && <>
            {sourceTags.length > 0 && <div className="source-tag-bar upload-tag-bar" role="group" aria-label="按标签筛选">
              <button className={`source-tag-chip${sourceTagIds.length ? "" : " active"}`} onClick={() => { setSourceTagIds([]); setSourceTagValues({}); }}>全部</button>
              {sourceTags.map((tag) => {
                const active = sourceTagIds.includes(tag.id);
                return (
                  <span key={tag.id} className={`source-tag-chip${active ? " active" : ""}`} style={{ borderColor: tag.color }}>
                    <button onClick={() => {
                      setSourceTagIds(active ? sourceTagIds.filter((id) => id !== tag.id) : [...sourceTagIds, tag.id]);
                      if (active) setSourceTagValues((prev) => { const next = { ...prev }; delete next[tag.id]; return next; });
                    }}>{tag.name} · {tag.image_count}</button>
                    {active && tag.values && (
                      <select
                        aria-label={`按${tag.name}取值筛选`}
                        value={sourceTagValues[tag.id] ?? ""}
                        onChange={(event) => setSourceTagValues((prev) => {
                          const next = { ...prev };
                          if (event.target.value) next[tag.id] = event.target.value;
                          else delete next[tag.id];
                          return next;
                        })}
                      >
                        <option value="">全部取值</option>
                        {tag.values.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    )}
                  </span>
                );
              })}
              {sourceTagIds.length > 1 && (
                <span className="tag-match-switch" role="group" aria-label="标签匹配逻辑">
                  <button className={sourceTagMatch === "all" ? "active" : ""} title="需同时包含所有所选标签" onClick={() => setSourceTagMatch("all")}>并</button>
                  <button className={sourceTagMatch === "any" ? "active" : ""} title="包含任一所选标签即可" onClick={() => setSourceTagMatch("any")}>或</button>
                </span>
              )}
            </div>}
            <div className="upload-options"><label>导入到 split<select value={uploadSplit} onChange={(event) => setUploadSplit(event.target.value as SplitName)}><option value="train">train · 训练集</option><option value="val">val · 验证集</option><option value="test">test · 测试集</option></select></label></div>
            <p className="muted upload-source-count">{sourceLoading ? "正在统计匹配图片…" : sourceTotal !== undefined ? `将同步 ${sourceTotal} 张图片${sourceTagIds.length ? (sourceTagMatch === "any" ? "（含任一所选标签）" : "（含所选全部标签）") : "（数据源全部图片）"}，文件会复制进数据集。` : ""}</p>
          </>}
          <footer className="data-exchange-footer"><span>同步不影响数据源中的原图。</span><div><button className="button" onClick={closeUpload}>取消</button><button className="button primary" disabled={props.busy || !sourceId || !sourceTotal} onClick={startSourceSync}>同步 {sourceTotal ?? ""} 张图片</button></div></footer>
        </>}
      </section>
    </div>}
    {exportTarget && <div className="modal-backdrop data-exchange-backdrop" role="presentation" onMouseDown={() => setExportTarget(undefined)}>
      <section className="dataset-dialog data-exchange-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-export-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="data-exchange-header"><div><span className="eyebrow">EXPORT CENTER</span><h2 id="dataset-export-dialog-title">导出“{exportTarget.name}”</h2><p>导出会使用当前已保存的图片 split、类别和标注。</p></div><button className="icon-button" onClick={() => setExportTarget(undefined)} aria-label="关闭">×</button></header>
        <div className="exchange-summary"><span>任务类型<strong>{taskDescription(exportTarget.task_type)}</strong></span><span>图片<strong>{exportTarget.image_count} 张</strong></span><span>已标注<strong>{exportTarget.annotated_image_count} 张</strong></span></div>
        <section><span className="exchange-label">导出格式</span><div className="format-option-grid"><button className={exportFormat === "yolo" ? "format-option selected" : "format-option"} onClick={() => setExportFormat("yolo")}><strong>YOLO ZIP</strong><span>标准 YOLO 目录、标签与 data.yaml</span></button>{["detect", "segment"].includes(exportTarget.task_type) && <button className={exportFormat === "coco" ? "format-option selected" : "format-option"} onClick={() => setExportFormat("coco")}><strong>COCO ZIP</strong><span>annotations.json 与原始图片</span></button>}</div></section>
        <footer className="data-exchange-footer"><span>下载文件会由浏览器保存到默认下载目录。</span><div><button className="button" onClick={() => setExportTarget(undefined)}>取消</button><a className="button primary" href={exportUrl ?? undefined} onClick={() => setExportTarget(undefined)}>下载 {exportFormat.toUpperCase()} ZIP</a></div></footer>
      </section>
    </div>}
    {renameTarget && (
      <div className="modal-backdrop" role="presentation" onMouseDown={() => setRenameTarget(undefined)}>
        <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="dataset-basic-info-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span className="eyebrow">BASIC INFO</span><h2 id="dataset-basic-info-title">基础信息维护 · {renameTarget.name}</h2><p className="muted">名称用于列表展示；产出模型名称将作为该数据集训练产出模型的默认命名（未填写时使用任务名）。</p></div><button className="icon-button" onClick={() => setRenameTarget(undefined)} aria-label="关闭">×</button></header>
          {dialogError && <p className="annotation-form-error">{dialogError}</p>}
          <label><span>数据集名称</span><input value={renameName} autoFocus onChange={(event) => setRenameName(event.target.value)} /></label>
          <label><span>产出模型名称</span><input value={renameModelName} placeholder="例如：blade-detector" onChange={(event) => setRenameModelName(event.target.value)} /></label>
          <footer><button className="button" disabled={renameBusy} onClick={() => setRenameTarget(undefined)}>取消</button><button className="button primary" disabled={renameBusy || !renameName.trim()} onClick={() => void submitBasicInfo()}>保存</button></footer>
        </section>
      </div>
    )}

    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
      <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dataset-delete-dialog-title" aria-describedby="dataset-delete-dialog-description" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">DELETE DATASET</span><h2 id="dataset-delete-dialog-title">删除数据集“{deleteTarget.name}”？</h2><p id="dataset-delete-dialog-description">这会永久删除该数据集的 {deleteTarget.image_count} 张图片、类别和标注，且无法撤销。</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
        <footer><button className="button" disabled={props.busy} onClick={() => setDeleteTarget(undefined)}>取消</button><button className="button danger" disabled={props.busy} onClick={() => { props.onDelete(deleteTarget); setDeleteTarget(undefined); }}>确认删除</button></footer>
      </section>
    </div>}
    {versionTarget && <DatasetVersionDialog dataset={versionTarget} onClose={() => setVersionTarget(undefined)} onChanged={() => props.onVersionsChange?.()} />}
  </main>;
}

function CardReport({ children, onClose }: { children: ReactNode; onClose: () => void }) { return <div className="dataset-card-report"><button className="dataset-card-report-close" onClick={onClose}>收起结果</button>{children}</div>; }
function QualityPanel({ report, compact = false }: { report: DatasetQualityReport; compact?: boolean }) { return <section className={compact ? "quality-panel compact-quality-panel" : "quality-panel"}><div className="quality-summary"><span><small>标注覆盖率</small><strong>{Math.round(report.summary.coverage * 100)}%</strong></span><span><small>标注总数</small><strong>{report.summary.annotation_count}</strong></span><span><small>小目标</small><strong>{report.summary.small_object_count}</strong></span><span><small>问题</small><strong>{report.issues.length}</strong></span></div>{!compact && <div className="quality-grid"><div><h3>类别分布</h3>{report.class_distribution.map((item) => <p key={item.class_id}><span>{item.class_index}. {item.name}</span><b>{item.count}</b><i><em style={{ width: `${Math.max(item.ratio * 100, item.count ? 3 : 0)}%` }} /></i></p>)}</div><div><h3>需要关注</h3>{report.issues.slice(0, 5).map((item, index) => <p key={`${item.type}-${index}`}><b>{item.level}</b><span>{item.message}</span></p>)}{!report.issues.length && <p>当前未发现需要关注的问题。</p>}</div></div>}</section>; }
function DuplicatePanel({ report, compact = false }: { report: DuplicateReport; compact?: boolean }) { return <section className={compact ? "quality-panel compact-quality-panel" : "quality-panel"}><div className="quality-summary"><span><small>精确重复</small><strong>{report.duplicate}</strong></span><span><small>相似图片</small><strong>{report.similar}</strong></span><span><small>无效图片</small><strong>{report.invalid_images}</strong></span><span><small>分析图片</small><strong>{report.images}</strong></span></div>{!compact && <div className="quality-grid"><div><h3>相似性分组</h3>{report.groups.slice(0, 6).map((item, index) => <p key={index}><span>{item.kind === "exact" ? "精确重复" : "相似"} · {item.image_ids.length} 张</span><b>{(item.score * 100).toFixed(0)}%</b></p>)}{!report.groups.length && <p>未发现重复或相似图片。</p>}</div><div><h3>处理建议</h3><p>重复检测为只读报告，不会删除任何图片。</p><p>相似图应由你在标注和 split 前人工决定是否保留。</p></div></div>}</section>; }


function ValidationPanel({ report, compact = false }: { report: ValidationReport; compact?: boolean }) {
  return <div className={`${report.valid ? "validation valid" : "validation invalid"}${compact ? " compact-validation" : ""}`}><strong>{report.valid ? "校验通过" : "发现需要处理的问题"}</strong><span>{report.error_count} errors · {report.warning_count} warnings</span>{!compact && report.issues.slice(0, 3).map((issue) => <small key={`${issue.code}-${issue.image_id ?? "dataset"}`}>{issue.level === "error" ? "!" : "·"} {issue.message}</small>)}</div>;
}

const CLASS_COLORS = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#14b8a6", "#f97316", "#06b6d4", "#ec4899", "#84cc16",
  "#6366f1", "#eab308", "#10b981", "#f43f5e", "#0ea5e9",
  "#8b5cf6", "#d946ef", "#facc15", "#4ade80", "#fb923c",
];
const IMAGE_STATUS_FILTERS: Array<{ value: "" | "annotated" | "unannotated"; label: string }> = [
  { value: "", label: "全部" },
  { value: "annotated", label: "已标注" },
  { value: "unannotated", label: "未标注" },
];
const IMAGE_SPLIT_FILTERS: Array<{ value: SplitName | ""; label: string }> = [
  { value: "", label: "全部" },
  { value: "train", label: "train" },
  { value: "val", label: "val" },
  { value: "test", label: "test" },
];

export function AnnotationView(props: { dataset: Dataset; image: ImageItem; images?: ImageItem[]; onImageSelect?: (image: ImageItem) => void; classes: ClassLabel[]; annotations: Annotation[]; activeClassId: string; onClassChange: (id: string) => void; onBack: () => void; onPrevious?: () => void; onNext?: (drafts?: AnnotationDraft[]) => void; hasPrevious?: boolean; hasNext?: boolean; onSave: (drafts: AnnotationDraft[]) => void; onDirtyChange?: (dirty: boolean) => void; samBusy?: boolean; onCreateClass?: (name: string, color: string) => Promise<ClassLabel | undefined>; onImportClasses?: (templateIds: string[]) => Promise<ClassLabel[] | undefined>; onUpdateClass?: (classId: string, payload: { sam3_prompt?: string; name?: string; color?: string }) => Promise<ClassLabel | undefined>; onDeleteClass?: (classId: string) => Promise<boolean | undefined>; onSam: (box: BBox) => Promise<SamPrediction>; onSamPoints: (points: [number, number][]) => Promise<SamPrediction>; busy: boolean; readOnly?: boolean; samCapabilities?: SamCapabilities; focusMode?: boolean; onToggleFocusMode?: () => void }) {
  const toDraft = (item: Annotation): AnnotationDraft => ({ id: item.id, class_id: item.class_id, type: item.type, bbox: item.bbox ?? undefined, polygon: item.polygon ?? undefined, obb: item.obb ?? undefined, keypoints: item.keypoints ?? undefined, source: item.source });
  const [drafts, setDrafts] = useState<AnnotationDraft[]>(props.annotations.map(toDraft));
  // 撤销栈：记录每次标注变更前的快照（不含纯选中态），切换图片/外部加载标注时清空
  const undoStackRef = useRef<AnnotationDraft[][]>([]);
  // 记录撤销快照后应用变更：捕获函数式更新前的当前值
  const applyDrafts = useCallback((action: AnnotationDraft[] | ((prev: AnnotationDraft[]) => AnnotationDraft[])) => {
    setDrafts((prev) => {
      const next = typeof action === "function" ? action(prev) : action;
      // 内容相同(如重复空操作)不入栈
      if (next !== prev) undoStackRef.current = [...undoStackRef.current.slice(-49), prev];
      return next;
    });
  }, []);

  const undoDrafts = useCallback(() => {
    setDrafts((prev) => {
      const stack = undoStackRef.current;
      if (!stack.length) return prev;
      const restore = stack[stack.length - 1];
      undoStackRef.current = stack.slice(0, -1);
      return restore;
    });
  }, []);

  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [newClassName, setNewClassName] = useState("");
  const [newClassColor, setNewClassColor] = useState(CLASS_COLORS[0]);
  const [showClassForm, setShowClassForm] = useState(props.classes.length === 0);
  const [classError, setClassError] = useState("");
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [deleteClassTarget, setDeleteClassTarget] = useState<ClassLabel | null>(null);
  const [editClassTarget, setEditClassTarget] = useState<ClassLabel | null>(null);
  const [editClassName, setEditClassName] = useState("");
  const [editClassColor, setEditClassColor] = useState(CLASS_COLORS[0]);
  const [editError, setEditError] = useState("");
  const [hiddenDraftIds, setHiddenDraftIds] = useState<Set<string>>(new Set());
  useEffect(() => { setHiddenDraftIds(new Set()); }, [props.image.id]);
  const [imagePage, setImagePage] = useState(0);
  const [imageSplitFilter, setImageSplitFilter] = useState<SplitName | "">("");
  const [imageStatusFilter, setImageStatusFilter] = useState<"" | "annotated" | "unannotated">("");
  useEffect(() => {
    setDrafts(props.annotations.map(toDraft));
    undoStackRef.current = [];
  }, [props.annotations, props.image.id]);
  const isDirty = JSON.stringify(drafts.map(stripDraftId)) !== JSON.stringify(props.annotations.map(toDraft).map(stripDraftId));
  useEffect(() => props.onDirtyChange?.(isDirty), [isDirty, props.onDirtyChange]);
  const selectedClass = props.classes.find((item) => item.id === props.activeClassId);
  const activeClassId = selectedClass?.id ?? props.classes[0]?.id ?? "";
  const promptValue = promptDraft ?? selectedClass?.sam3_prompt ?? "";
  useEffect(() => { setPromptDraft(null); setPromptError(""); }, [selectedClass?.id]);
  const savePrompt = async () => {
    if (!selectedClass || !props.onUpdateClass) return;
    setPromptBusy(true);
    setPromptError("");
    try {
      const updated = await props.onUpdateClass(selectedClass.id, { sam3_prompt: promptValue.trim() || undefined });
      if (updated) setPromptDraft(null);
    } catch (reason) {
      setPromptError(errorMessage(reason));
    } finally {
      setPromptBusy(false);
    }
  };
  const translatePrompt = async () => {
    if (!selectedClass) return;
    setPromptBusy(true);
    setPromptError("");
    try {
      const result = await api.translateSam3Prompt(selectedClass.name);
      setPromptDraft(result.sam3_prompt ?? "");
      const message = sam3TranslateMessage(result);
      if (message) setPromptError(message);
    } catch (reason) {
      setPromptError(errorMessage(reason));
    } finally {
      setPromptBusy(false);
    }
  };
  useEffect(() => {
    if (activeClassId && activeClassId !== props.activeClassId) props.onClassChange(activeClassId);
  }, [activeClassId, props.activeClassId, props.onClassChange]);
  useEffect(() => {
    if (props.classes.length === 0) setShowClassForm(true);
    if (props.classes.length > 0 && !props.classes.some((item) => item.id === props.activeClassId)) setShowClassForm(false);
  }, [props.classes, props.activeClassId]);
  const filteredImages = (props.images ?? []).filter((item) =>
    (!imageSplitFilter || item.split === imageSplitFilter)
    && (!imageStatusFilter || item.status === imageStatusFilter));
  const imageCount = filteredImages.length;
  const imagePageCount = Math.max(1, Math.ceil(imageCount / ANNOTATION_IMAGE_PAGE_SIZE));
  useEffect(() => setImagePage(0), [imageSplitFilter, imageStatusFilter]);
  useEffect(() => {
    if (!filteredImages.length) {
      setImagePage(0);
      return;
    }
    const imageIndex = filteredImages.findIndex((item) => item.id === props.image.id);
    if (imageIndex >= 0) setImagePage(Math.min(Math.floor(imageIndex / ANNOTATION_IMAGE_PAGE_SIZE), imagePageCount - 1));
  }, [props.image.id, props.images, imageSplitFilter, imageStatusFilter, imagePageCount]);
  const appendSamDrafts = (suggestion: SamPrediction) => {
    const source: AnnotationDraft["source"] = suggestion.backend_used === "ultralytics_sam" ? "sam" : "manual";
    setDrafts((items) => [
      ...items,
      ...suggestion.polygons.map((polygon): AnnotationDraft => ({ id: newDraftId(), class_id: suggestion.class_id, type: "polygon", polygon, source })),
    ]);
  };
  const requestSam = async (box: BBox) => {
    try {
      const suggestion = await props.onSam(box);
      appendSamDrafts(suggestion);
    } catch {
      // The page-level request handler has already surfaced the error.
    }
  };
  const requestSamPoints = async (points: [number, number][]) => {
    try {
      const suggestion = await props.onSamPoints(points);
      appendSamDrafts(suggestion);
    } catch {
      // The page-level request handler has already surfaced the error.
    }
  };
  const annotated = drafts.map((draft, index) => { const classItem = props.classes.find((item) => item.id === draft.class_id); return { ...draft, id: draft.id ?? `draft-${index}`, image_id: props.image.id, dataset_id: props.dataset.id, class_index: classItem?.class_index ?? 0, label: classItem?.name ?? "未选择类别", color: classItem?.color ?? "#f97316", created_at: "", updated_at: "" }; }) as Annotation[];
  const chooseClass = (classId: string) => applyDrafts([{ class_id: classId, type: "classify", source: "manual" }]);
  const changeDraftClass = (index: number, classId: string) => applyDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, class_id: classId } : item));
  const classInUse = (classId: string) => drafts.some((draft) => draft.class_id === classId);
  const toggleDraftVisibility = (id: string) => {
    const wasHidden = hiddenDraftIds.has(id);
    setHiddenDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!wasHidden && selectedAnnotationId === id) setSelectedAnnotationId(null);
  };
  const allDraftsHidden = drafts.length > 0 && drafts.every((draft, index) => hiddenDraftIds.has(draftId(draft, index)));
  const hideAllDrafts = () => {
    setHiddenDraftIds(new Set(drafts.map((draft, index) => draftId(draft, index))));
    setSelectedAnnotationId(null);
  };
  const showAllDrafts = () => setHiddenDraftIds(new Set());
  const saveEditClass = async () => {
    if (editClassTarget && !editClassName.trim()) {
      setEditError("类别名称不能为空。");
      return;
    }
    if (!editClassTarget || !props.onUpdateClass) return;
    const updated = await props.onUpdateClass(editClassTarget.id, { name: editClassName.trim(), color: editClassColor });
    if (updated) setEditClassTarget(null);
  };

  const confirmDeleteClass = async () => {
    if (!deleteClassTarget || !props.onDeleteClass) return;
    const removed = await props.onDeleteClass(deleteClassTarget.id);
    if (removed) setDeleteClassTarget(null);
  };
  const deleteAnnotation = (id: string) => {
    if (props.readOnly) return;
    applyDrafts((items) => items.filter((item, index) => draftId(item, index) !== id));
    setSelectedAnnotationId(null);
  };
  const addClass = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newClassName.trim();
    if (!name || !props.onCreateClass) return;
    setClassError("");
    let created: ClassLabel | undefined;
    try {
      created = await props.onCreateClass(name, newClassColor);
    } catch (reason) {
      setClassError(errorMessage(reason));
      return;
    }
    if (!created) return;
    setNewClassName("");
    setNewClassColor(CLASS_COLORS[(created.class_index + 1) % CLASS_COLORS.length]);
    setShowClassForm(false);
  };
  useEffect(() => {
    if (selectedAnnotationId && !annotated.some((item) => item.id === selectedAnnotationId)) setSelectedAnnotationId(null);
  }, [annotated, selectedAnnotationId]);

  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return; if ((event.key === "Delete" || event.key === "Backspace") && selectedAnnotationId) { event.preventDefault(); deleteAnnotation(selectedAnnotationId); return; } if (event.key === "Escape") { if (selectedAnnotationId) { setSelectedAnnotationId(null); return; } if (props.focusMode) props.onToggleFocusMode?.(); return; } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undoDrafts(); return; } const lower = event.key.toLowerCase(); const adNav = props.focusMode && !event.ctrlKey && !event.metaKey; if ((event.key === "ArrowLeft" || (adNav && lower === "a")) && props.hasPrevious && !props.busy) props.onPrevious?.(); if ((event.key === "ArrowRight" || (adNav && lower === "d")) && props.hasNext && !props.busy) props.onNext?.(drafts); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); props.onSave(drafts); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [drafts, props, selectedAnnotationId]);
  return <main className="annotation-layout"><div className="annotation-head"><button className="button" onClick={props.onBack}>← 返回数据集</button><div><span className="eyebrow">{props.dataset.name} / {props.dataset.task_type}</span><h1>{props.image.file_name}<span className={`annotation-save-state${isDirty ? " dirty" : ""}`} role="status">{isDirty ? "未保存修改" : "已保存"}</span></h1>{props.readOnly && <p className="annotation-readonly-banner">只读模式：当前激活的是历史版本 v{props.dataset.active_version_number}（最新 v{props.dataset.latest_version_number}），仅可查看；请新建版本或激活最新版本后再编辑。</p>}</div><div className="annotation-navigation" aria-label="图片导航">{props.onPrevious && <button className="button" disabled={props.busy || !props.hasPrevious} title="上一张（←）" onClick={props.onPrevious}>← 上一张</button>}{props.onNext && <button className="button" disabled={props.busy || !props.hasNext} title="下一张（→）" onClick={() => props.onNext?.(drafts)}>下一张 →</button>}</div><div className="annotation-actions"><select aria-label="当前类别" value={activeClassId} disabled={!props.classes.length} onChange={(event) => props.onClassChange(event.target.value)}>{!props.classes.length && <option value="">请先新增类别</option>}{props.classes.map((item) => <option key={item.id} value={item.id}>{item.class_index}: {item.name}</option>)}</select><button className="button primary" disabled={props.busy || !activeClassId || props.readOnly} onClick={() => props.onSave(drafts)}>保存标注</button>{props.onToggleFocusMode && <button className="button" title="Esc" onClick={props.onToggleFocusMode}>{props.focusMode ? "退出专注" : "专注模式"}</button>}</div></div><div className="annotation-body">
    {props.images && props.images.length > 0 && <aside className="annotation-image-sidebar panel"><div className="annotation-list-heading"><span className="eyebrow">TASK IMAGES</span><strong>{imageCount} 张图片</strong></div><div className="annotation-image-split-tabs" role="tablist" aria-label="按 split 筛选图片">{IMAGE_SPLIT_FILTERS.map((filter) => <button key={filter.value || "all"} type="button" role="tab" aria-selected={imageSplitFilter === filter.value} className={imageSplitFilter === filter.value ? "active" : ""} onClick={() => setImageSplitFilter(filter.value)}>{filter.label}</button>)}</div><div className="annotation-image-split-tabs" role="tablist" aria-label="按标注状态筛选图片">{IMAGE_STATUS_FILTERS.map((filter) => <button key={filter.value || "status-all"} type="button" role="tab" aria-selected={imageStatusFilter === filter.value} className={imageStatusFilter === filter.value ? "active" : ""} onClick={() => setImageStatusFilter(filter.value)}>{filter.label}</button>)}</div><div className="annotation-image-list">{filteredImages.slice(imagePage * ANNOTATION_IMAGE_PAGE_SIZE, (imagePage + 1) * ANNOTATION_IMAGE_PAGE_SIZE).map((item, index) => { const absoluteIndex = imagePage * ANNOTATION_IMAGE_PAGE_SIZE + index; return <button key={item.id} className={item.id === props.image.id ? "annotation-image-item active" : "annotation-image-item"} aria-label={`选择图片 ${item.file_name}`} onClick={() => props.onImageSelect?.(item)}><img src={api.imageThumbnailUrl(item.id)} alt="" loading="lazy" decoding="async" /><span className="annotation-image-copy"><strong>{String(absoluteIndex + 1).padStart(2, "0")} · {item.file_name}</strong><small className={item.status === "annotated" ? "annotated" : "unannotated"}>{item.split} · {item.status === "annotated" ? "已标注" : "未标注"}</small></span></button>; })}{!filteredImages.length && <p className="annotation-empty-state">当前筛选下没有图片。</p>}</div>{imagePageCount > 1 && <div className="annotation-image-pagination"><button className="button" disabled={imagePage === 0} onClick={() => setImagePage((page) => Math.max(0, page - 1))}>上一页</button><span>第 {imagePage + 1} / {imagePageCount} 页</span><button className="button" disabled={imagePage >= imagePageCount - 1} onClick={() => setImagePage((page) => Math.min(imagePageCount - 1, page + 1))}>下一页</button></div>}</aside>}
    <div className="annotation-canvas-column">{props.dataset.task_type === "classify" ? <section className="canvas-card classification-card"><span className="eyebrow">IMAGE CLASSIFICATION</span><h2>选择这张图片的唯一类别</h2><p className="hint">分类数据集每张图片只能保存一个类别，训练时会按 train/类别名/图片 导出。</p>{props.classes.length ? <div className="class-strip">{props.classes.map((item) => <button key={item.id} className={drafts[0]?.class_id === item.id ? "class-chip active" : "class-chip"} onClick={() => chooseClass(item.id)}><i style={{ background: item.color }} />{item.class_index}: {item.name}</button>)}</div> : <p className="annotation-empty-state">还没有类别，请在右侧“类别”面板中新增一个类别。</p>}</section> : <AnnotationCanvas image={props.image} annotations={annotated} activeClassId={activeClassId} activeClassColor={props.classes.find((item) => item.id === activeClassId)?.color} selectedAnnotationId={selectedAnnotationId} onSelectAnnotation={setSelectedAnnotationId} taskType={props.dataset.task_type} onChange={applyDrafts} onSamBox={props.dataset.task_type === "segment" && activeClassId ? requestSam : undefined} onSamPoints={props.dataset.task_type === "segment" && activeClassId ? requestSamPoints : undefined} samBusy={props.samBusy ?? false} samCapabilities={props.samCapabilities} poseConfig={props.dataset.pose_config ?? null} hiddenAnnotationIds={hiddenDraftIds} readOnly={props.readOnly} />}</div>
    <aside className="annotation-sidebar panel"><section className="annotation-class-manager"><div className="annotation-sidebar-heading"><div><span className="eyebrow">LABEL CLASSES</span><h2>{props.classes.length} 个类别</h2></div><div className="annotation-sidebar-heading-actions">{props.onImportClasses && <button type="button" className="button" disabled={props.busy || props.readOnly} onClick={() => setShowLibraryPicker(true)}>类别库</button>}<button type="button" className="button" disabled={props.busy || !props.onCreateClass || props.readOnly} onClick={() => setShowClassForm((value) => !value)}>{showClassForm ? "收起" : "+ 新增类别"}</button></div></div>{showClassForm && <form className="annotation-class-form" onSubmit={(event) => void addClass(event)}><label><span>类别名称</span><input autoFocus value={newClassName} placeholder="例如：person" onChange={(event) => setNewClassName(event.target.value)} /></label><div className="annotation-class-form-row"><label><span>颜色</span><div className="class-color-palette" role="radiogroup" aria-label="类别颜色">{CLASS_COLORS.map((color) => <button type="button" key={color} role="radio" aria-checked={newClassColor === color} className={`class-color-swatch${newClassColor === color ? " selected" : ""}`} style={{ background: color }} onClick={() => setNewClassColor(color)} aria-label={color} />)}</div></label><button className="button primary" type="submit" disabled={props.busy || !newClassName.trim()}>添加</button></div>{classError && <small className="annotation-form-error">{classError}</small>}</form>}<div className="annotation-class-list">{props.classes.map((item) => <div className="annotation-class-row" key={item.id}><button type="button" className={`annotation-class-item${item.id === activeClassId ? " active" : ""}`} onClick={() => props.onClassChange(item.id)}><i style={{ background: item.color }} /><span><strong>{item.class_index}. {item.name}</strong><small>{item.id === activeClassId ? "当前绘制类别" : "点击切换"}{props.dataset.task_type === "segment" ? ` · ${item.sam3_prompt || "未设置 SAM3 提示词"}` : ""}</small></span></button>{props.onUpdateClass && <button type="button" className="annotation-class-edit" aria-label={`编辑类别 ${item.name}`} title="编辑名称与颜色" disabled={props.busy || props.readOnly} onClick={() => { setEditClassTarget(item); setEditClassName(item.name); setEditClassColor(item.color); setEditError(""); }}><PencilIcon /></button>}{props.onDeleteClass && <button type="button" className="annotation-class-delete" aria-label={`删除类别 ${item.name}`} title={classInUse(item.id) ? "该类别正被标注使用，删除标注后才能删除类别" : "删除此类别"} disabled={props.busy || classInUse(item.id) || props.readOnly} onClick={() => setDeleteClassTarget(item)}><TrashIcon /></button>}</div>)}{!props.classes.length && <p className="muted">先新增一个类别，标注对象就不会再显示为“未选择类别”。</p>}</div>{props.dataset.task_type === "segment" && selectedClass && <div className="class-prompt-editor"><span className="class-prompt-label">SAM3 提示词 · {selectedClass.name}</span><div className="class-prompt-controls"><input aria-label={`类别 ${selectedClass.name} 的 SAM3 英文提示词`} value={promptValue} placeholder="英文概念，例如 screen" onChange={(event) => setPromptDraft(event.target.value)} /><button type="button" className="button" disabled={promptBusy} onClick={() => void translatePrompt()}>翻译</button><button type="button" className="button primary" disabled={promptBusy || !props.onUpdateClass || props.readOnly} onClick={() => void savePrompt()}>保存</button></div>{promptError ? <small className="annotation-form-error">{promptError}</small> : <small className="muted">远程 SAM3 仅支持英文概念提示，点选/框选前请维护好当前类别。</small>}</div>}</section><section className="annotation-shape-list"><div className="annotation-sidebar-heading"><div><span className="eyebrow">SAVED SHAPES</span><h2>{drafts.length} 个标注</h2></div><div className="annotation-sidebar-heading-actions"><button type="button" className="annotation-visibility-button" aria-label="全部隐藏" title="在画布上隐藏全部标注" disabled={!drafts.length || allDraftsHidden} onClick={hideAllDrafts}><EyeOffIcon /></button><button type="button" className="annotation-visibility-button" aria-label="全部显示" title="在画布上显示全部标注" disabled={!hiddenDraftIds.size} onClick={showAllDrafts}><EyeIcon /></button></div></div>{drafts.map((draft, index) => { const id = draftId(draft, index); const hidden = hiddenDraftIds.has(id); return <div className={`shape-row${id === selectedAnnotationId ? " active" : ""}${hidden ? " hidden" : ""}`} key={id} role="button" tabIndex={0} onClick={() => setSelectedAnnotationId(id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedAnnotationId(id); } }}><span className="shape-index">{index + 1}</span><div><select className="shape-class-select" aria-label={`标注 ${index + 1} 类别`} value={draft.class_id} disabled={!props.classes.length} onClick={(event) => event.stopPropagation()} onChange={(event) => changeDraftClass(index, event.target.value)}>{!props.classes.length && <option value="">未选择类别</option>}{props.classes.map((item) => <option key={item.id} value={item.id}>{item.class_index}: {item.name}</option>)}</select><small>{annotationLabel(draft.type)}</small></div><button type="button" className="annotation-visibility-button" aria-label={hidden ? `显示标注 ${index + 1}` : `隐藏标注 ${index + 1}`} aria-pressed={hidden} title={hidden ? "在画布上显示此标注" : "在画布上隐藏此标注"} onClick={(event) => { event.stopPropagation(); toggleDraftVisibility(id); }} onKeyDown={(event) => event.stopPropagation()}>{hidden ? <EyeOffIcon /> : <EyeIcon />}</button><button type="button" className="annotation-delete-button" aria-label={`删除标注 ${index + 1}`} title="删除此标注" onClick={(event) => { event.stopPropagation(); deleteAnnotation(id); }} onKeyDown={(event) => event.stopPropagation()}><TrashIcon /></button></div>; })}{!drafts.length && <p className="muted">{props.dataset.task_type === "classify" ? "请选择一个类别。" : "在图片上拖拽或点击创建标注。"}</p>}</section></aside></div>{showLibraryPicker && props.onImportClasses && <ClassLibraryPicker existingClasses={props.classes} isSegment={props.dataset.task_type === "segment"} busy={props.busy} onImport={props.onImportClasses} onClose={() => setShowLibraryPicker(false)} />}{editClassTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditClassTarget(null)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-class-edit-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">EDIT CLASS</span><h2 id="annotation-class-edit-title">编辑类别 {editClassTarget.class_index}</h2><p>修改名称与颜色，已有标注会同步使用新颜色。</p></div><button className="icon-button" onClick={() => setEditClassTarget(null)} aria-label="关闭">×</button></header>
            <label><span>类别名称</span><input value={editClassName} autoFocus onChange={(event) => setEditClassName(event.target.value)} /></label>
            <label><span>颜色</span><div className="class-color-palette" role="radiogroup" aria-label="类别颜色">{CLASS_COLORS.map((color) => <button type="button" key={color} role="radio" aria-checked={editClassColor === color} className={`class-color-swatch${editClassColor === color ? " selected" : ""}`} style={{ background: color }} onClick={() => setEditClassColor(color)} aria-label={color} />)}</div></label>
            {editError && <small className="annotation-form-error">{editError}</small>}
            <footer><button className="button" disabled={props.busy} onClick={() => setEditClassTarget(null)}>取消</button><button className="button primary" disabled={props.busy || !editClassName.trim()} onClick={() => void saveEditClass()}>保存</button></footer>
          </section>
        </div>
      )}
      {deleteClassTarget && props.onDeleteClass && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteClassTarget(null)}><section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="annotation-class-delete-title" aria-describedby="annotation-class-delete-description" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">DELETE CLASS</span><h2 id="annotation-class-delete-title">删除类别“{deleteClassTarget.name}”？</h2><p id="annotation-class-delete-description">只有未被任何标注使用的类别才能删除；若其他图片仍在使用该类别，删除会被拒绝并提示。</p></div><button className="icon-button" onClick={() => setDeleteClassTarget(null)} aria-label="关闭">×</button></header><footer><button className="button" disabled={props.busy} onClick={() => setDeleteClassTarget(null)}>取消</button><button className="button danger" disabled={props.busy} onClick={() => void confirmDeleteClass()}>确认删除</button></footer></section></div>}</main>;
}

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。"; }
function annotationLabel(type: Annotation["type"]): string { return ({ bbox: "Bounding box", polygon: "Polygon", obb: "Oriented bounding box", classify: "Image classification", pose: "Pose keypoints" })[type]; }
function taskDescription(taskType: TaskType): string { return ({ detect: "目标检测 · Bounding Box", segment: "实例分割 · Polygon / SAM", obb: "旋转框检测 · OBB", classify: "图像分类", pose: "关键点检测 · Pose" })[taskType]; }
function draftId(draft: AnnotationDraft, index: number): string { return draft.id ?? `draft-${index}`; }
function stripDraftId(draft: AnnotationDraft): Omit<AnnotationDraft, "id"> { const { id: _id, ...payload } = draft; return payload; }
function newDraftId(): string { return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function PencilIcon() { return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3 6h18M19 6v14H5V6m3 0V4h8v2M10 11v6M14 11v6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>; }
function EyeIcon() { return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>; }
function EyeOffIcon() { return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m4 4 16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M9.9 5.9a9.7 9.7 0 0 1 2.1-.4c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.7 3.4M6.5 6.9A16.9 16.9 0 0 0 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.3 3.6-.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /><path d="M10 10a2.9 2.9 0 0 0 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></svg>; }
