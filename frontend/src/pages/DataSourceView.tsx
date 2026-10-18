import { useEffect, useRef, useState } from "react";
import { api, apiUrl } from "../api/client";
import { Toast } from "../components/Toast";
import type { SourceDataset, SourceImage, SourceImagePage, SourceTag } from "../types";

const PAGE_SIZE = 60;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "数据源操作失败，请稍后重试。";
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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
  const [tagFilter, setTagFilter] = useState("");
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<SourceImage>();
  const [ftpOpen, setFtpOpen] = useState(false);
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpRecursive, setFtpRecursive] = useState(true);
  const [tagDialog, setTagDialog] = useState<{ mode: "create" } | { mode: "edit"; tag: SourceTag }>();
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#3157d5");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDetail = async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) setLoading(true);
    try {
      const [nextTags, nextPage] = await Promise.all([
        api.listSourceTags(dataset.id),
        api.listSourceImages(dataset.id, { offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE, tagId: tagFilter || undefined, query: query || undefined }),
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
  }, [dataset.id, tagFilter, query]);

  useEffect(() => {
    void loadDetail();
  }, [dataset.id, tagFilter, query, pageIndex]);

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
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    await runAction(async () => {
      const result = await api.uploadSourceImages(dataset.id, list);
      return result.imported ? `已导入 ${result.imported} 张图片${result.invalid ? `，跳过 ${result.invalid} 个无效文件` : ""}` : `没有可导入的文件（跳过 ${result.invalid} 个无效文件）`;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submitFtpSync = async () => {
    const path = ftpPath.trim();
    if (!path) return;
    setFtpOpen(false);
    await runAction(async () => {
      const result = await api.syncSourceFromFtp(dataset.id, path, ftpRecursive);
      return `FTP 同步完成：新增 ${result.synced} 张${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`;
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
      if (tagFilter === tag.id) setTagFilter("");
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
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => void upload(event.target.files)} />
          <button className="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>上传图片</button>
          <button className="button" disabled={busy} onClick={() => setFtpOpen(true)}>FTP 同步</button>
          <button className="button" onClick={onBack}>← 返回列表</button>
        </div>
      </header>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      <section className="panel source-toolbar">
        <div className="source-tag-bar" role="group" aria-label="标签筛选">
          <button className={`source-tag-chip${tagFilter ? "" : " active"}`} onClick={() => setTagFilter("")}>全部</button>
          {tags.map((tag) => (
            <span key={tag.id} className={`source-tag-chip${tagFilter === tag.id ? " active" : ""}`} style={{ borderColor: tag.color }}>
              <button onClick={() => setTagFilter(tagFilter === tag.id ? "" : tag.id)}>{tag.name} · {tag.image_count}</button>
              <button className="source-tag-edit" title="编辑标签" onClick={() => { setTagDialog({ mode: "edit", tag }); setTagName(tag.name); setTagColor(tag.color); }}>✎</button>
              <button className="source-tag-edit" title="删除标签" disabled={busy} onClick={() => void deleteTag(tag)}>×</button>
            </span>
          ))}
          <button className="button" disabled={busy} onClick={() => { setTagDialog({ mode: "create" }); setTagName(""); setTagColor("#3157d5"); }}>＋ 新建标签</button>
        </div>
        <form className="source-search" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }}>
          <input value={queryInput} placeholder="按文件名搜索…" onChange={(event) => setQueryInput(event.target.value)} />
          <button className="button" type="submit">搜索</button>
          {query && <button type="button" className="button" onClick={() => { setQueryInput(""); setQuery(""); }}>清除</button>}
        </form>
      </section>
      {loading ? (
        <p className="muted">正在读取图片…</p>
      ) : items.length ? (
        <section className="source-image-grid">
          {items.map((image) => (
            <button key={image.id} className="source-image-card" onClick={() => setPreview(image)}>
              <img src={apiUrl(image.file_url)} alt={image.file_name} loading="lazy" />
              <span className="source-image-name">{image.file_name}</span>
              <span className="source-image-meta">
                {image.source_type === "ftp" ? "FTP" : "上传"} · {formatSize(image.size_bytes)}
                {image.tags.length > 0 && <i>{image.tags.map((tag) => tag.name).join(" · ")}</i>}
              </span>
            </button>
          ))}
        </section>
      ) : (
        <section className="dataset-empty-card">
          <span className="dataset-empty-icon">▦</span>
          <h2>{query || tagFilter ? "没有符合条件的图片" : "还没有图片"}</h2>
          <p>{query || tagFilter ? "调整搜索词或标签筛选后再试。" : "上传本地图片，或从 FTP 目录同步一批图片进来。"}</p>
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
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="source-ftp-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">FTP SYNC</span><h2 id="source-ftp-title">从 FTP 同步图片</h2><p>读取 FTP 目录下的图片文件并复制到本数据集；连接配置在“设置 → FTP 服务”。非图片和超限文件会跳过。</p></div><button className="icon-button" onClick={() => setFtpOpen(false)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitFtpSync(); }}>
              <input autoFocus value={ftpPath} placeholder="FTP 目录，例如：/data/cam1" onChange={(event) => setFtpPath(event.target.value)} />
              <label className="source-toggle"><input type="checkbox" checked={ftpRecursive} onChange={(event) => setFtpRecursive(event.target.checked)} />包含子目录</label>
              <footer>
                <button type="button" className="button" onClick={() => setFtpOpen(false)}>取消</button>
                <button className="button primary" type="submit" disabled={!ftpPath.trim()}>开始同步</button>
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
                <span className="muted">{preview.width}×{preview.height} · {formatSize(preview.size_bytes)}</span>
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
