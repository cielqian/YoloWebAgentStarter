import { useEffect, useRef, useState } from "react";
import { api, apiUrl, type FtpSyncProgressEvent } from "../api/client";
import { Toast } from "../components/Toast";
import type { FtpEntry, SourceDataset, SourceImage, SourceImagePage, SourceTag } from "../types";

const PAGE_SIZE = 60;
const IMAGE_RE = /\.(jpe?g|png|bmp|webp)$/i;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "数据源操作失败，请稍后重试。";
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function parentFtpPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function formatImportTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DataSourceView() {
  const [datasets, setDatasets] = useState<SourceDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeId, setActiveId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SourceDataset>();
  const [renameTarget, setRenameTarget] = useState<SourceDataset>();
  const [renameName, setRenameName] = useState("");

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setDatasets(await api.listSourceDatasets());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (activeId && !datasets.some((item) => item.id === activeId)) setActiveId(undefined);
  }, [datasets, activeId]);

  const runAction = async (action: () => Promise<string>) => {
    setBusy(true);
    setError("");
    try {
      setNotice(await action());
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    setCreateOpen(false);
    await runAction(async () => {
      const created = await api.createSourceDataset(name, createDescription.trim() || undefined);
      await load(true);
      setActiveId(created.id);
      return `已创建数据集“${created.name}”`;
    });
    setCreateName("");
    setCreateDescription("");
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const target = renameTarget;
    setRenameTarget(undefined);
    await runAction(async () => {
      await api.updateSourceDataset(target.id, { name });
      await load(true);
      return `已重命名为“${name}”`;
    });
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(undefined);
    await runAction(async () => {
      await api.deleteSourceDataset(target.id);
      await load(true);
      return `已删除数据集“${target.name}”`;
    });
  };

  const active = datasets.find((item) => item.id === activeId);

  return (
    <main className="source-page">
      {active ? (
        <DataSourceDetail
          dataset={active}
          onChanged={() => void load(true)}
          onBack={() => setActiveId(undefined)}
        />
      ) : (
        <>
          <header className="ftp-head">
            <div>
              <span className="eyebrow">DATA SOURCES</span>
              <h1>数据源</h1>
              <p>管理原始图片集合：可从 FTP 同步或本地上传，用标签组织和检索图片，与标注任务互相独立。</p>
            </div>
            <div className="header-actions">
              <button className="button primary" onClick={() => { setCreateName(""); setCreateDescription(""); setCreateOpen(true); }}>新建数据集</button>
              <button className="button" disabled={loading} onClick={() => void load()}>刷新</button>
            </div>
          </header>
          <Toast kind="error" message={error} onClose={() => setError("")} />
          <Toast kind="success" message={notice} onClose={() => setNotice("")} />
          {loading ? (
            <p className="muted">正在加载数据集…</p>
          ) : datasets.length ? (
            <section className="source-grid">
              {datasets.map((item) => (
                <article key={item.id} className="source-card">
                  <header>
                    <span className="source-card-icon" aria-hidden="true">▦</span>
                    <div>
                      <h2>{item.name}</h2>
                      <small>{item.description || "—"}</small>
                    </div>
                  </header>
                  <div className="source-card-metrics">
                    <span><small>图片</small><strong>{item.image_count}</strong></span>
                    <span><small>标签</small><strong>{item.tag_count}</strong></span>
                  </div>
                  <footer>
                    <button className="button primary" onClick={() => setActiveId(item.id)}>打开</button>
                    <button className="button" disabled={busy} onClick={() => { setRenameTarget(item); setRenameName(item.name); }}>重命名</button>
                    <button className="button danger" disabled={busy} onClick={() => setDeleteTarget(item)}>删除</button>
                  </footer>
                </article>
              ))}
            </section>
          ) : (
            <section className="dataset-empty-card">
              <span className="dataset-empty-icon">▦</span>
              <h2>还没有数据集</h2>
              <p>新建一个数据集后，可以上传图片或从 FTP 目录同步，再为图片打标签管理。</p>
              <div><button className="button primary" onClick={() => setCreateOpen(true)}>新建数据集</button></div>
            </section>
          )}
        </>
      )}

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setCreateOpen(false)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="source-create-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">NEW SOURCE DATASET</span><h2 id="source-create-title">新建数据集</h2><p>仅用于管理原始图片与标签，不涉及标注。</p></div><button className="icon-button" onClick={() => setCreateOpen(false)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
              <input autoFocus value={createName} placeholder="数据集名称，例如：路口白天" onChange={(event) => setCreateName(event.target.value)} />
              <input value={createDescription} placeholder="描述（可选）" onChange={(event) => setCreateDescription(event.target.value)} />
              <footer>
                <button type="button" className="button" onClick={() => setCreateOpen(false)}>取消</button>
                <button className="button primary" type="submit" disabled={!createName.trim()}>创建</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {renameTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRenameTarget(undefined)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="source-rename-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">RENAME</span><h2 id="source-rename-title">重命名“{renameTarget.name}”</h2></div><button className="icon-button" onClick={() => setRenameTarget(undefined)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
              <input autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} />
              <footer>
                <button type="button" className="button" onClick={() => setRenameTarget(undefined)}>取消</button>
                <button className="button primary" type="submit" disabled={!renameName.trim()}>确认</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
          <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="source-delete-title" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">DELETE</span><h2 id="source-delete-title">删除数据集“{deleteTarget.name}”？</h2><p>其中 {deleteTarget.image_count} 张图片、标签和关联文件会被永久删除，且无法撤销。</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
            <footer>
              <button className="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</button>
              <button className="button danger" disabled={busy} onClick={() => void submitDelete()}>确认删除</button>
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

function DataSourceDetail({ dataset, onChanged, onBack }: { dataset: SourceDataset; onChanged: () => void; onBack: () => void }) {
  const [tags, setTags] = useState<SourceTag[]>([]);
  const [page, setPage] = useState<SourceImagePage>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<"all" | "any">("all");
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<SourceImage>();
  const [ftpOpen, setFtpOpen] = useState(false);
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpEntries, setFtpEntries] = useState<FtpEntry[]>([]);
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpSelected, setFtpSelected] = useState<string[]>([]);
  const [ftpTagIds, setFtpTagIds] = useState<string[]>([]);
  const [ftpRecursive, setFtpRecursive] = useState(true);
  const [syncProgress, setSyncProgress] = useState<FtpSyncProgressEvent>();
  const [syncTotal, setSyncTotal] = useState(0);
  const [tagDialog, setTagDialog] = useState<{ mode: "create" } | { mode: "edit"; tag: SourceTag }>();
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#3157d5");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState<"add" | "remove">("add");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTagIds, setUploadTagIds] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDetail = async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) setLoading(true);
    try {
      const [nextTags, nextPage] = await Promise.all([
        api.listSourceTags(dataset.id),
        api.listSourceImages(dataset.id, { offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE, tagIds: tagFilter.length ? tagFilter : undefined, tagMatch, query: query || undefined }),
      ]);
      setTags(nextTags);
      setPage(nextPage);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPageIndex(0);
    setSelectedIds([]);
  }, [dataset.id, tagFilter, query]);

  useEffect(() => {
    void loadDetail();
  }, [dataset.id, tagFilter, tagMatch, query, pageIndex]);

  const runAction = async (action: () => Promise<string>) => {
    setBusy(true);
    setError("");
    try {
      setNotice(await action());
      await Promise.all([loadDetail({ quiet: true }), onChanged()]);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      setSyncProgress(undefined);
    }
  };

  const handleSyncEvent = (event: FtpSyncProgressEvent) => {
    if (event.stage === "download") setSyncTotal(event.synced);
    setSyncProgress(event);
  };

  const pickFiles = (files: FileList | null) => {
    if (files?.length) setPendingFiles(Array.from(files));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submitUpload = async () => {
    if (!pendingFiles.length) return;
    const files = pendingFiles;
    const tagIds = [...uploadTagIds];
    setUploadOpen(false);
    await runAction(async () => {
      const result = await api.uploadSourceImages(dataset.id, files, tagIds);
      const tagNote = tagIds.length ? `，已附加 ${tagIds.length} 个标签` : "";
      return result.imported
        ? `已导入 ${result.imported} 张图片${tagNote}${result.invalid ? `，跳过 ${result.invalid} 个无效文件` : ""}`
        : `没有可导入的文件（跳过 ${result.invalid} 个无效文件）`;
    });
  };

  const toggleSelected = (imageId: string) => {
    setSelectedIds((ids) => (ids.includes(imageId) ? ids.filter((id) => id !== imageId) : [...ids, imageId]));
  };

  const selectAllPage = () => {
    setSelectedIds((ids) => Array.from(new Set([...ids, ...items.map((item) => item.id)])));
  };

  const applyBatchTag = async (tag: SourceTag) => {
    if (!selectedIds.length) return;
    const imageIds = [...selectedIds];
    const remove = batchMode === "remove";
    await runAction(async () => {
      const result = await api.batchUpdateSourceImageTags(dataset.id, imageIds, [tag.id], remove);
      return remove ? `已为 ${result.updated} 张图片移除标签“${tag.name}”` : `已为 ${result.updated} 张图片添加标签“${tag.name}”`;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
    setBatchMode("add");
  };

  const loadFtp = async (path: string) => {
    setFtpLoading(true);
    setError("");
    try {
      const payload = await api.listFtp(path);
      setFtpPath(payload.path);
      setFtpEntries(payload.entries);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setFtpLoading(false);
    }
  };

  const openFtpPicker = () => {
    setFtpPath("/");
    setFtpEntries([]);
    setFtpSelected([]);
    setFtpTagIds([]);
    setFtpOpen(true);
    void loadFtp("/");
  };

  const syncFtpFolder = async () => {
    const path = ftpPath;
    const tagIds = [...ftpTagIds];
    setFtpOpen(false);
    await runAction(async () => {
      const result = await api.syncSourceFromFtp(dataset.id, { path, recursive: ftpRecursive, tagIds }, handleSyncEvent);
      const hint = result.truncated ? "；目录图片较多，已达单次同步上限，请分目录分批同步" : "";
      return `FTP 同步完成：新增 ${result.synced} 张${result.skipped ? `，跳过 ${result.skipped} 个` : ""}${hint}`;
    });
  };

  const syncFtpFiles = async () => {
    if (!ftpSelected.length) return;
    const files = [...ftpSelected];
    const tagIds = [...ftpTagIds];
    setFtpOpen(false);
    await runAction(async () => {
      const result = await api.syncSourceFromFtp(dataset.id, { path: "/", recursive: false, filePaths: files, tagIds }, handleSyncEvent);
      return `FTP 导入完成：新增 ${result.synced} 张${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`;
    });
  };

  const submitTagDialog = async () => {
    const name = tagName.trim();
    if (!name) return;
    const dialog = tagDialog;
    setTagDialog(undefined);
    await runAction(async () => {
      if (dialog?.mode === "edit") {
        await api.updateSourceTag(dataset.id, dialog.tag.id, { name, color: tagColor });
        return `标签已更新为“${name}”`;
      }
      await api.createSourceTag(dataset.id, name, tagColor);
      return `已新增标签“${name}”`;
    });
  };

  const deleteTag = async (tag: SourceTag) => {
    await runAction(async () => {
      await api.deleteSourceTag(dataset.id, tag.id);
      if (tagFilter.includes(tag.id)) setTagFilter(tagFilter.filter((id) => id !== tag.id));
      return `已删除标签“${tag.name}”`;
    });
  };

  const toggleImageTag = async (image: SourceImage, tag: SourceTag) => {
    const enabled = image.tags.some((item) => item.id === tag.id);
    const nextTagIds = enabled ? image.tags.filter((item) => item.id !== tag.id).map((item) => item.id) : [...image.tags.map((item) => item.id), tag.id];
    try {
      setBusy(true);
      setError("");
      const updated = await api.updateSourceImage(dataset.id, image.id, { tag_ids: nextTagIds });
      setPreview(updated);
      await loadDetail({ quiet: true });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const renameImage = async (image: SourceImage, fileName: string) => {
    const name = fileName.trim();
    if (!name || name === image.file_name) return;
    try {
      setBusy(true);
      setError("");
      const updated = await api.updateSourceImage(dataset.id, image.id, { file_name: name });
      setPreview(updated);
      await loadDetail({ quiet: true });
      setNotice("图片已重命名");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteImage = async (image: SourceImage) => {
    await runAction(async () => {
      await api.deleteSourceImage(dataset.id, image.id);
      setPreview(undefined);
      return `已删除“${image.file_name}”`;
    });
  };

  const items = page?.items ?? [];
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.limit)) : 1;

  return (
    <>
      <header className="ftp-head">
        <div>
          <span className="eyebrow">DATA SOURCE</span>
          <h1>{dataset.name}</h1>
          <p>{dataset.description || "管理该数据集的图片与标签。"} · 共 {page?.total ?? dataset.image_count} 张图片 · {tags.length} 个标签</p>
        </div>
        <div className="header-actions">
          <button className="button" onClick={onBack}>← 返回列表</button>
        </div>
      </header>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      {syncProgress && (
        <section className="panel sync-progress" role="status">
          <span className="sync-progress-spin" aria-hidden="true" />
          <span>
            {syncProgress.stage === "download"
              ? `正在从 FTP 下载图片：已获取 ${syncProgress.synced} 张${syncProgress.skipped ? `，跳过 ${syncProgress.skipped} 个` : ""}…`
              : syncTotal
                ? `正在导入图片：${syncProgress.synced}/${syncTotal} 张…`
                : `正在导入图片：已保存 ${syncProgress.synced} 张…`}
          </span>
        </section>
      )}
      <div className="source-sticky">
        <section className="panel source-toolbar">
          <div className="source-toolbar-top">
            <div className="header-actions">
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => pickFiles(event.target.files)} />
              <button className="button primary" disabled={busy} onClick={() => { setUploadTagIds([]); setPendingFiles([]); setUploadOpen(true); }}>上传图片</button>
              <button className="button" disabled={busy} onClick={openFtpPicker}>FTP 同步</button>
              {selectMode ? (
                <button className="button" onClick={exitSelectMode}>退出选择</button>
              ) : (
                <button className="button" disabled={busy || !items.length} onClick={() => setSelectMode(true)}>批量选择</button>
              )}
            </div>
            <form className="source-search" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }}>
              <input value={queryInput} placeholder="按文件名搜索…" onChange={(event) => setQueryInput(event.target.value)} />
              <button className="button" type="submit">搜索</button>
              {query && <button type="button" className="button" onClick={() => { setQueryInput(""); setQuery(""); }}>清除</button>}
            </form>
          </div>
          <div className="source-tag-bar" role="group" aria-label="标签筛选">
            <button className={`source-tag-chip${tagFilter.length ? "" : " active"}`} onClick={() => setTagFilter([])}>全部</button>
            {tags.map((tag) => (
              <span key={tag.id} className={`source-tag-chip${tagFilter.includes(tag.id) ? " active" : ""}`} style={{ borderColor: tag.color }}>
                <button onClick={() => setTagFilter(tagFilter.includes(tag.id) ? tagFilter.filter((id) => id !== tag.id) : [...tagFilter, tag.id])}>{tag.name} · {tag.image_count}</button>
                <button className="source-tag-edit" title="编辑标签" onClick={() => { setTagDialog({ mode: "edit", tag }); setTagName(tag.name); setTagColor(tag.color); }}>✎</button>
                <button className="source-tag-edit" title="删除标签" disabled={busy} onClick={() => void deleteTag(tag)}>×</button>
              </span>
            ))}
            {tagFilter.length > 1 && (
              <span className="tag-match-switch" role="group" aria-label="标签匹配逻辑">
                <button className={tagMatch === "all" ? "active" : ""} title="需同时包含所有所选标签" onClick={() => setTagMatch("all")}>并</button>
                <button className={tagMatch === "any" ? "active" : ""} title="包含任一所选标签即可" onClick={() => setTagMatch("any")}>或</button>
              </span>
            )}
            <button className="button" disabled={busy} onClick={() => { setTagDialog({ mode: "create" }); setTagName(""); setTagColor("#3157d5"); }}>＋ 新建标签</button>
          </div>
        </section>
        {selectMode && (
          <section className="panel source-batch-bar">
            <strong>已选 {selectedIds.length} 张</strong>
            <button className="button" disabled={busy || !items.length} onClick={selectAllPage}>全选本页</button>
            <button className="button" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>清空选择</button>
            <div className="source-batch-mode" role="group" aria-label="批量操作模式">
              <button className={batchMode === "add" ? "active" : ""} onClick={() => setBatchMode("add")}>关联标签</button>
              <button className={batchMode === "remove" ? "active" : ""} onClick={() => setBatchMode("remove")}>取消关联</button>
            </div>
            <div className="source-batch-tags" role="group" aria-label="批量操作标签">
              {tags.length ? tags.map((tag) => (
                <button key={tag.id} className="source-tag-button" style={{ borderColor: tag.color }} disabled={busy || !selectedIds.length} onClick={() => void applyBatchTag(tag)}>
                  {batchMode === "add" ? "＋" : "－"} {tag.name}
                </button>
              )) : <span className="muted">还没有标签，先在上方“新建标签”后再批量应用。</span>}
            </div>
          </section>
        )}
      </div>
      {loading ? (
        <p className="muted">正在读取图片…</p>
      ) : items.length ? (
        <section className="source-image-grid">
          {items.map((image) => {
            const isSelected = selectedIds.includes(image.id);
            return (
              <button
                key={image.id}
                className={`source-image-card${selectMode ? " selectable" : ""}${selectMode && isSelected ? " selected" : ""}`}
                onClick={() => (selectMode ? toggleSelected(image.id) : setPreview(image))}
              >
                {selectMode && <span className="source-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>}
                <img src={apiUrl(image.thumbnail_url)} alt={image.file_name} loading="lazy" />
                <span className="source-image-name">{image.file_name}</span>
                <span className="source-image-meta">
                  {image.source_type === "ftp" ? "FTP" : "上传"} · {formatSize(image.size_bytes)}
                  <small>导入 {formatImportTime(image.created_at)}</small>
                  {image.tags.length > 0 && <i>{image.tags.map((tag) => tag.name).join(" · ")}</i>}
                </span>
              </button>
            );
          })}
        </section>
      ) : (
        <section className="dataset-empty-card">
          <span className="dataset-empty-icon">▦</span>
          <h2>{query || tagFilter.length ? "没有符合条件的图片" : "还没有图片"}</h2>
          <p>{query || tagFilter.length ? "调整搜索词或标签筛选后再试。" : "上传本地图片，或从 FTP 目录同步一批图片进来。"}</p>
        </section>
      )}
      {page && page.total > page.limit && (
        <div className="source-pagination">
          <button className="button" disabled={pageIndex === 0} onClick={() => setPageIndex((index) => Math.max(0, index - 1))}>上一页</button>
          <span>第 {pageIndex + 1} / {totalPages} 页 · 共 {page.total} 张</span>
          <button className="button" disabled={pageIndex >= totalPages - 1} onClick={() => setPageIndex((index) => Math.min(totalPages - 1, index + 1))}>下一页</button>
        </div>
      )}

      {ftpOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setFtpOpen(false)}>
          <section className="dataset-dialog ftp-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="source-ftp-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">FTP SYNC</span><h2 id="source-ftp-title">从 FTP 选择图片</h2><p>浏览 FTP 目录后可整个文件夹同步，或勾选多个文件导入，可先选标签附加到导入的图片；连接配置在“设置 → FTP 服务”。非图片和超限文件会跳过。</p></div><button className="icon-button" onClick={() => setFtpOpen(false)} aria-label="关闭">×</button></header>
            <div className="ftp-picker">
              <div className="ftp-toolbar">
                <button className="button" disabled={ftpLoading || ftpPath === "/"} onClick={() => void loadFtp(parentFtpPath(ftpPath))}>返回上级</button>
                <nav className="ftp-breadcrumb" aria-label="FTP 路径">
                  <button disabled={ftpLoading} onClick={() => void loadFtp("/")}>/</button>
                  {ftpPath !== "/" && ftpPath.slice(1).split("/").map((crumb, index, parts) => {
                    const target = `/${parts.slice(0, index + 1).join("/")}`;
                    return <span key={target}>/ <button disabled={ftpLoading} onClick={() => void loadFtp(target)}>{crumb}</button></span>;
                  })}
                </nav>
                <button className="button" disabled={ftpLoading} onClick={() => void loadFtp(ftpPath)}>刷新</button>
              </div>
              <div className="ftp-picker-list">
                {ftpLoading ? (
                  <p className="muted">正在读取目录…</p>
                ) : ftpEntries.length ? (
                  <table className="ftp-table">
                    <thead>
                      <tr><th className="ftp-check-col" aria-label="选择" /><th>名称</th><th>大小</th></tr>
                    </thead>
                    <tbody>
                      {ftpEntries.map((entry) => {
                        if (entry.is_dir) {
                          return (
                            <tr key={entry.path}>
                              <td className="ftp-check-col" />
                              <td>
                                <button className="ftp-name dir" onClick={() => void loadFtp(entry.path)} title="打开目录">
                                  <span aria-hidden="true">📁</span><span>{entry.name}</span>
                                </button>
                              </td>
                              <td className="muted">文件夹</td>
                            </tr>
                          );
                        }
                        const isImage = IMAGE_RE.test(entry.name);
                        const checked = ftpSelected.includes(entry.path);
                        const toggleSelected = () => setFtpSelected((paths) => (checked ? paths.filter((item) => item !== entry.path) : [...paths, entry.path]));
                        return (
                          <tr
                            key={entry.path}
                            className={`ftp-file-row${isImage ? "" : " unsupported"}${checked ? " selected" : ""}`}
                            onClick={() => {
                              if (isImage && !busy) toggleSelected();
                            }}
                          >
                            <td className="ftp-check-col">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!isImage || busy}
                                onClick={(event) => event.stopPropagation()}
                                onChange={toggleSelected}
                              />
                            </td>
                            <td>
                              <span className={`ftp-name${isImage ? "" : " disabled"}`} title={isImage ? undefined : "仅支持 jpg / jpeg / png / bmp / webp 图片"}>
                                <span aria-hidden="true">📄</span><span>{entry.name}</span>
                              </span>
                            </td>
                            <td>{entry.size != null ? formatSize(entry.size) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted ftp-empty">此目录为空。</p>
                )}
              </div>
              <div className="source-batch-tags ftp-picker-tags" role="group" aria-label="FTP 导入标签">
                {tags.length ? tags.map((tag) => {
                  const enabled = ftpTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      className={`source-tag-button${enabled ? " active" : ""}`}
                      style={{ borderColor: tag.color }}
                      onClick={() => setFtpTagIds((ids) => (ids.includes(tag.id) ? ids.filter((item) => item !== tag.id) : [...ids, tag.id]))}
                    >
                      {tag.name}
                    </button>
                  );
                }) : <span className="muted">还没有标签，可先在上方“新建标签”，导入后再打标签。</span>}
              </div>
              <footer className="ftp-picker-actions">
                <label className="source-toggle"><input type="checkbox" checked={ftpRecursive} onChange={(event) => setFtpRecursive(event.target.checked)} />包含子目录</label>
                <button className="button" disabled={busy || ftpLoading} onClick={() => void syncFtpFolder()}>同步整个文件夹</button>
                <button className="button primary" disabled={busy || !ftpSelected.length} onClick={() => void syncFtpFiles()}>导入所选 {ftpSelected.length} 张</button>
                <button className="button" onClick={() => setFtpOpen(false)}>取消</button>
              </footer>
            </div>
          </section>
        </div>
      )}

      {uploadOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setUploadOpen(false)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="source-upload-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">UPLOAD</span><h2 id="source-upload-title">上传图片</h2><p>可先勾选标签，上传成功后自动附加到本次导入的所有图片。</p></div><button className="icon-button" onClick={() => setUploadOpen(false)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitUpload(); }}>
              <div className="source-batch-tags" role="group" aria-label="上传时附加的标签">
                {tags.length ? tags.map((tag) => {
                  const enabled = uploadTagIds.includes(tag.id);
                  return (
                    <button
                      type="button"
                      key={tag.id}
                      className={`source-tag-button${enabled ? " active" : ""}`}
                      style={{ borderColor: tag.color }}
                      onClick={() => setUploadTagIds((ids) => (ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]))}
                    >
                      {tag.name}
                    </button>
                  );
                }) : <span className="muted">还没有标签，可先在上方“新建标签”，或直接上传后再打标签。</span>}
              </div>
              <div className="source-upload-row">
                <button type="button" className="button" onClick={() => fileInputRef.current?.click()}>选择图片</button>
                <span className="muted">{pendingFiles.length ? `已选择 ${pendingFiles.length} 个文件` : "尚未选择文件"}</span>
              </div>
              <footer>
                <button type="button" className="button" onClick={() => setUploadOpen(false)}>取消</button>
                <button className="button primary" type="submit" disabled={busy || !pendingFiles.length}>开始上传</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {tagDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTagDialog(undefined)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="source-tag-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">TAG</span><h2 id="source-tag-title">{tagDialog.mode === "create" ? "新建标签" : `编辑标签“${tagDialog.tag.name}”`}</h2></div><button className="icon-button" onClick={() => setTagDialog(undefined)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitTagDialog(); }}>
              <input autoFocus value={tagName} placeholder="标签名，例如：白天" onChange={(event) => setTagName(event.target.value)} />
              <label className="source-color-row">颜色 <input type="color" value={tagColor} onChange={(event) => setTagColor(event.target.value)} /></label>
              <footer>
                <button type="button" className="button" onClick={() => setTagDialog(undefined)}>取消</button>
                <button className="button primary" type="submit" disabled={!tagName.trim()}>保存</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setPreview(undefined)}>
          <section className="source-preview" role="dialog" aria-modal="true" aria-labelledby="source-preview-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <form onSubmit={(event) => { event.preventDefault(); void renameImage(preview, (event.currentTarget.elements.namedItem("fileName") as HTMLInputElement).value); }}>
                <span className="eyebrow">PREVIEW</span>
                <input name="fileName" defaultValue={preview.file_name} aria-label="文件名" onBlur={(event) => void renameImage(preview, event.target.value)} />
              </form>
              <div className="header-actions">
                <span className="muted">{preview.width}×{preview.height} · {formatSize(preview.size_bytes)} · 导入 {formatImportTime(preview.created_at)}</span>
                <button className="icon-button" onClick={() => setPreview(undefined)} aria-label="关闭">×</button>
              </div>
            </header>
            <div className="source-preview-body">
              <img src={apiUrl(preview.file_url)} alt={preview.file_name} />
            </div>
            <footer>
              <div className="source-preview-tags" role="group" aria-label="图片标签">
                {tags.length ? tags.map((tag) => {
                  const enabled = preview.tags.some((item) => item.id === tag.id);
                  return (
                    <button key={tag.id} className={`source-tag-chip${enabled ? " active" : ""}`} style={{ borderColor: tag.color }} disabled={busy} onClick={() => void toggleImageTag(preview, tag)}>
                      {tag.name}
                    </button>
                  );
                }) : <span className="muted">还没有标签，先在上方“新建标签”。</span>}
              </div>
              <button className="button danger" disabled={busy} onClick={() => void deleteImage(preview)}>删除图片</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
