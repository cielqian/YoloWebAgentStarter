import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button as AntdButton,
  Empty,
  Flex,
  Form as AntdForm,
  Input as AntdInput,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag as AntdTag,
  Typography,
  type TableProps,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { api, apiUrl, type FtpSyncProgressEvent } from "../api/client";
import type { FtpEntry, MaterialType, SourceDataset, SourceImage, SourceImagePage, SourceTag } from "../types";

const PAGE_SIZE = 60;
const IMAGE_RE = /\.(jpe?g|png|bmp|webp)$/i;

/** 素材类型多选下拉(复选框列表),取值为类型名称。 */
function MaterialTypeSelect({ options, value, onChange }: { options: MaterialType[]; value: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (name: string) => onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  return (
    <div className="material-select">
      <button type="button" className="material-select-trigger" onClick={() => setOpen((current) => !current)}>
        {value.length ? value.join("、") : "选择素材类型（可多选）"}
        <span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="material-select-menu" role="listbox" aria-label="素材类型">
          {options.length ? options.map((item) => (
            <label key={item.id} className="material-select-option">
              <input type="checkbox" checked={value.includes(item.name)} onChange={() => toggle(item.name)} />
              <span>{item.name}</span>
            </label>
          )) : <small className="muted">素材类型库为空，请先到「设置 → 基础数据 → 素材类型」添加。</small>}
        </div>
      )}
    </div>
  );
}

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
  const [createMaterials, setCreateMaterials] = useState<string[]>([]);
  const [materialTypes, setMaterialTypes] = useState<MaterialType[]>([]);
  const [renameMaterials, setRenameMaterials] = useState<string[]>([]);
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
    api.listMaterialTypes().then(setMaterialTypes).catch(() => undefined);
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
      const created = await api.createSourceDataset(name, createDescription.trim() || undefined, createMaterials);
      await load(true);
      setActiveId(created.id);
      return `已创建数据集“${created.name}”`;
    });
    setCreateName("");
    setCreateDescription("");
    setCreateMaterials([]);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    const target = renameTarget;
    setRenameTarget(undefined);
    await runAction(async () => {
      await api.updateSourceDataset(target.id, { name, material_types: renameMaterials.length ? renameMaterials : null });
      await load(true);
      return `已更新“${name}”`;
    });
  };

  const submitDelete = async (target: SourceDataset) => {
    await runAction(async () => {
      await api.deleteSourceDataset(target.id);
      await load(true);
      return `已删除数据集“${target.name}”`;
    });
  };

  const active = datasets.find((item) => item.id === activeId);

  const columns: TableProps<SourceDataset>["columns"] = [
    { title: "#", key: "_index", width: 50, render: (_, __, index) => index + 1 },
    { title: "名称", dataIndex: "name", key: "name", render: (_, item) => (
      <Space size={4}>
        <strong>{item.name}</strong>
        {item.material_types?.map((type) => <AntdTag key={type}>{type}</AntdTag>)}
      </Space>
    ) },
    { title: "描述", dataIndex: "description", key: "description", ellipsis: true, render: (value: string | null) => value || <Typography.Text type="secondary">—</Typography.Text> },
    { title: "图片", dataIndex: "image_count", key: "image_count", width: 80, render: (value: number) => <Typography.Text style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{value}</Typography.Text> },
    { title: "标签", dataIndex: "tag_count", key: "tag_count", width: 80, render: (value: number) => <Typography.Text style={{ fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>{value}</Typography.Text> },
    { title: "操作", key: "actions", width: 160, render: (_, item) => (
      <Space size="small" onClick={(event) => event.stopPropagation()}>
        <AntdButton type="link" size="small" onClick={() => setActiveId(item.id)}>打开</AntdButton>
        <AntdButton type="link" size="small" disabled={busy} onClick={() => { setRenameTarget(item); setRenameName(item.name); setRenameMaterials(item.material_types ?? []); }}>编辑</AntdButton>
        <Popconfirm title={`删除数据集"${item.name}"？`} description={`其中 ${item.image_count} 张图片、标签和关联文件会被永久删除，且无法撤销。`} okText="确认删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void submitDelete(item)}>
          <AntdButton type="link" size="small" danger disabled={busy}>删除</AntdButton>
        </Popconfirm>
      </Space>
    ) },
  ];

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
          {error ? <Alert type="error" showIcon closable title={error} style={{ marginBottom: 12 }} /> : null}
          {notice ? <Alert type="success" showIcon closable title={notice} style={{ marginBottom: 12 }} /> : null}
          {loading ? (
            <Typography.Paragraph type="secondary">正在加载数据集…</Typography.Paragraph>
          ) : datasets.length ? (
            <Table<SourceDataset>
              rowKey="id"
              columns={columns}
              dataSource={datasets}
              loading={loading}
              pagination={{
                showSizeChanger: false,
                showTotal: (total) => `共 ${total} 个`,
                pageSize: 10,
              }}
              size="middle"
              onRow={(record) => ({ onClick: () => setActiveId(record.id), style: { cursor: "pointer" } })}
              title={() => (
                <Flex justify="space-between" align="center">
                  <Space size={8}>
                    <strong>所有数据源</strong>
                    <Typography.Text type="secondary">{datasets.length} 个</Typography.Text>
                  </Space>
                  <Space size={8}>
                    <AntdButton icon={<ReloadOutlined />} disabled={loading} onClick={() => void load()}>刷新</AntdButton>
                    <AntdButton type="primary" icon={<PlusOutlined />} onClick={() => { setCreateName(""); setCreateDescription(""); setCreateOpen(true); }}>新建数据集</AntdButton>
                  </Space>
                </Flex>
              )}
            />
          ) : (
            <Empty description="还没有数据集。新建一个数据集后，可以上传图片或从 FTP 目录同步，再为图片打标签管理。">
              <AntdButton type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建数据集</AntdButton>
            </Empty>
          )}
        </>
      )}

      <Modal
        title="新建数据集"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
        onOk={() => void submitCreate()}
        okButtonProps={{ disabled: !createName.trim() }}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>仅用于管理原始图片与标签，不涉及标注。</Typography.Paragraph>
        <AntdInput autoFocus value={createName} placeholder="数据集名称，例如：路口白天" onChange={(event) => setCreateName(event.target.value)} style={{ marginBottom: 12 }} />
        <AntdInput value={createDescription} placeholder="描述（可选）" onChange={(event) => setCreateDescription(event.target.value)} style={{ marginBottom: 12 }} />
        <MaterialTypeSelect options={materialTypes} value={createMaterials} onChange={setCreateMaterials} />
      </Modal>

      <Modal
        title={`编辑"${renameTarget?.name ?? ""}"`}
        open={Boolean(renameTarget)}
        onCancel={() => setRenameTarget(undefined)}
        okText="确认"
        cancelText="取消"
        destroyOnHidden
        onOk={() => void submitRename()}
        okButtonProps={{ disabled: !renameName.trim() }}
      >
        <AntdInput autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} style={{ marginBottom: 12 }} />
        <MaterialTypeSelect options={materialTypes} value={renameMaterials} onChange={setRenameMaterials} />
      </Modal>
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
  const [tagValueFilter, setTagValueFilter] = useState<Record<string, string>>({});
  const [tagMatch, setTagMatch] = useState<"all" | "any">("all");
  const [query, setQuery] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<SourceImage>();
  const [viewMode, setViewMode] = useState<"grid" | "browser">("grid");
  const [ftpOpen, setFtpOpen] = useState(false);
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpEntries, setFtpEntries] = useState<FtpEntry[]>([]);
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpSelected, setFtpSelected] = useState<string[]>([]);
  const [ftpTagIds, setFtpTagIds] = useState<string[]>([]);
  const [ftpTagValues, setFtpTagValues] = useState<Record<string, string>>({});
  const [ftpRecursive, setFtpRecursive] = useState(true);
  const [syncProgress, setSyncProgress] = useState<FtpSyncProgressEvent>();
  const [syncTotal, setSyncTotal] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState<"add" | "remove">("add");
  const [batchPickedTagIds, setBatchPickedTagIds] = useState<string[]>([]);
  const [batchValues, setBatchValues] = useState<Record<string, string>>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTagIds, setUploadTagIds] = useState<string[]>([]);
  const [uploadTagValues, setUploadTagValues] = useState<Record<string, string>>({});
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDetail = async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) setLoading(true);
    try {
      const [nextTags, nextPage] = await Promise.all([
        api.listSourceTags(dataset.id),
        api.listSourceImages(dataset.id, { offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE, tagIds: tagFilter.length ? tagFilter : undefined, tagValues: tagValueFilter, tagMatch, query: query || undefined }),
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
  }, [dataset.id, tagFilter, tagValueFilter, query]);

  useEffect(() => {
    void loadDetail();
  }, [dataset.id, tagFilter, tagValueFilter, tagMatch, query, pageIndex]);

  const items = page?.items ?? [];
  const previewIndex = preview ? items.findIndex((item) => item.id === preview.id) : -1;
  const stepPreview = (delta: number) => {
    if (previewIndex < 0 || !items.length) return;
    const next = items[(previewIndex + delta + items.length) % items.length];
    setPreview(next);
  };

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const lower = event.key.toLowerCase();
      if (lower === "d" || event.key === "ArrowRight") { event.preventDefault(); stepPreview(1); }
      else if (lower === "a" || event.key === "ArrowLeft") { event.preventDefault(); stepPreview(-1); }
      else if (event.key === "Escape") setPreview(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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

  // 枚举标签未手动改过取值时,默认用第一个取值(与下拉框显示一致),避免"看着选了值实际没传"
  const resolveTagValues = (pickedIds: string[], values: Record<string, string>) =>
    Object.fromEntries(
      tags.filter((tag) => pickedIds.includes(tag.id) && tag.values?.length).map((tag) => [tag.id, values[tag.id] ?? tag.values![0]]),
    );

  const submitUpload = async () => {
    if (!pendingFiles.length) return;
    const files = pendingFiles;
    const tagIds = [...uploadTagIds];
    const tagValues = resolveTagValues(tagIds, uploadTagValues);
    setUploadOpen(false);
    await runAction(async () => {
      const result = await api.uploadSourceImages(dataset.id, files, tagIds, tagValues);
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

  const applyBatchTags = async () => {
    if (!selectedIds.length || !batchPickedTagIds.length) return;
    const imageIds = [...selectedIds];
    const tagIds = [...batchPickedTagIds];
    const remove = batchMode === "remove";
    const tagValues = remove ? {} : resolveTagValues(tagIds, batchValues);
    await runAction(async () => {
      await api.batchUpdateSourceImageTags(dataset.id, imageIds, tagIds, remove, tagValues);
      const names = tags.filter((tag) => tagIds.includes(tag.id)).map((tag) => tag.name).join("、");
      return remove ? `已为 ${imageIds.length} 张图片移除标签：${names}` : `已为 ${imageIds.length} 张图片关联标签：${names}`;
    });
    setBatchPickedTagIds([]);
    setBatchValues({});
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds([]);
    setBatchMode("add");
    setBatchPickedTagIds([]);
    setBatchValues({});
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
      const result = await api.syncSourceFromFtp(dataset.id, { path, recursive: ftpRecursive, tagIds, tagValues: resolveTagValues(tagIds, ftpTagValues) }, handleSyncEvent);
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
      const result = await api.syncSourceFromFtp(dataset.id, { path: "/", recursive: false, filePaths: files, tagIds, tagValues: resolveTagValues(tagIds, ftpTagValues) }, handleSyncEvent);
      return `FTP 导入完成：新增 ${result.synced} 张${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`;
    });
  };



  const toggleImageTag = async (image: SourceImage, tag: SourceTag, value?: string) => {
    const enabled = image.tags.some((item) => item.id === tag.id);
    const nextTagIds = enabled ? image.tags.filter((item) => item.id !== tag.id).map((item) => item.id) : [...image.tags.map((item) => item.id), tag.id];
    const tagValues = { ...(tag.values && !enabled ? { [tag.id]: value ?? tag.values[0] } : {}) };
    try {
      setBusy(true);
      setError("");
      const updated = await api.updateSourceImage(dataset.id, image.id, { tag_ids: nextTagIds, ...(Object.keys(tagValues).length ? { tag_values: tagValues } : {}) });
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


  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.limit)) : 1;

  return (
    <>
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <div>
          <strong style={{ fontSize: 16 }}>{dataset.name}</strong>
          <small style={{ marginLeft: 10, color: "#7d8799" }}>{dataset.description || ""} · {page?.total ?? dataset.image_count} 张图片 · {tags.length} 个标签</small>
        </div>
        <button className="button" onClick={onBack}>← 返回列表</button>
      </Flex>
      {error ? <Alert type="error" showIcon closable title={error} style={{ marginBottom: 12 }} /> : null}
      {notice ? <Alert type="success" showIcon closable title={notice} style={{ marginBottom: 12 }} /> : null}
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
            <button className={`source-tag-chip${tagFilter.length ? "" : " active"}`} onClick={() => { setTagFilter([]); setTagValueFilter({}); }}>全部</button>
            {tags.map((tag) => {
              const active = tagFilter.includes(tag.id);
              return (
                <span key={tag.id} className={`source-tag-chip enum${active ? " active" : ""}`} style={{ borderColor: tag.color }}>
                  <button type="button" onClick={() => setTagFilter((ids) => ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])}>
                    {tag.name} · {tag.image_count}
                  </button>
                  {active && tag.values && (
                    <select
                      aria-label={`按${tag.name}取值筛选`}
                      value={tagValueFilter[tag.id] ?? ""}
                      onChange={(event) => setTagValueFilter((prev) => {
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
            {tagFilter.length > 1 && (
              <span className="tag-match-switch" role="group" aria-label="标签匹配逻辑">
                <button className={tagMatch === "all" ? "active" : ""} title="需同时包含所有所选标签" onClick={() => setTagMatch("all")}>并</button>
                <button className={tagMatch === "any" ? "active" : ""} title="包含任一所选标签即可" onClick={() => setTagMatch("any")}>或</button>
              </span>
            )}

          </div>
        </section>
        {selectMode && (
          <section className="panel source-batch-bar">
            <strong>已选 {selectedIds.length} 张</strong>
            <button className="button" disabled={busy || !items.length} onClick={selectAllPage}>全选本页</button>
            <button className="button" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>清空选择</button>
            <div className="source-batch-mode" role="group" aria-label="批量操作模式">
              <button className={batchMode === "add" ? "active" : ""} onClick={() => { setBatchMode("add"); setBatchPickedTagIds([]); setBatchValues({}); }}>关联标签</button>
              <button className={batchMode === "remove" ? "active" : ""} onClick={() => { setBatchMode("remove"); setBatchPickedTagIds([]); setBatchValues({}); }}>取消关联</button>
            </div>
            <div className="source-batch-tags" role="group" aria-label="选择要操作的标签">
              {tags.length ? tags.map((tag) => {
                const picked = batchPickedTagIds.includes(tag.id);
                return (
                  <span key={tag.id} className={`source-tag-chip batch${picked ? " active" : ""}`} style={{ borderColor: tag.color }}>
                    <button type="button" disabled={busy} onClick={() => setBatchPickedTagIds((ids) => picked ? ids.filter((id) => id !== tag.id) : [...ids, tag.id])}>
                      {batchMode === "add" ? "+" : "－"} {tag.name}
                    </button>
                    {picked && batchMode === "add" && tag.values && (
                      <select aria-label={`${tag.name} 取值`} value={batchValues[tag.id] ?? tag.values[0]} disabled={busy} onChange={(event) => setBatchValues((prev) => ({ ...prev, [tag.id]: event.target.value }))}>
                        {tag.values.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    )}
                  </span>
                );
              }) : <span className="muted">还没有标签，请到「设置 → 基础数据 → 标签库」维护。</span>}
            </div>
            <button className="button primary" disabled={busy || !selectedIds.length || !batchPickedTagIds.length} onClick={() => void applyBatchTags()}>
              {batchMode === "add" ? `关联 ${batchPickedTagIds.length || ""} 个标签` : `取消 ${batchPickedTagIds.length || ""} 个标签`}
            </button>
          </section>
        )}
      </div>
      {loading ? (
        <p className="muted">正在读取图片…</p>
      ) : items.length ? (
        <>
        <div className="source-view-mode" role="group" aria-label="展示方式">
          <button type="button" className={viewMode === "grid" ? "active" : ""} onClick={() => { setViewMode("grid"); setPreview(undefined); }}>网格</button>
          <button type="button" className={viewMode === "browser" ? "active" : ""} onClick={() => setViewMode("browser")}>浏览(左列表·右大图)</button>
        </div>
        {viewMode === "grid" ? (
        <section className="source-image-grid">
          {items.map((image) => {
            const isSelected = selectedIds.includes(image.id);
            return (
              <button
                key={image.id}
                className={`source-image-card${selectMode ? " selectable" : ""}${selectMode && isSelected ? " selected" : ""}`}
                onClick={() => { if (selectMode) toggleSelected(image.id); else { setViewMode("browser"); setPreview(image); } }}
              >
                {selectMode && <span className="source-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>}
                <img src={apiUrl(image.thumbnail_url)} alt={image.file_name} loading="lazy" />
                <span className="source-image-name">{image.file_name}</span>
                <span className="source-image-meta">
                  {image.source_type === "ftp" ? "FTP" : "上传"} · {formatSize(image.size_bytes)}
                  <small>导入 {formatImportTime(image.created_at)}</small>
                  {image.tags.length > 0 && <i>{image.tags.map((tag) => tag.name + (tag.value ? ":" + tag.value : "")).join(" · ")}</i>}
                </span>
              </button>
            );
          })}
        </section>
        ) : (
        <section className="source-browser">
          <aside className="source-browser-list" aria-label="图片列表">
            {items.map((image) => (
              <div key={image.id} className={`source-browser-item${preview?.id === image.id ? " active" : ""}`}>
                <button type="button" className="source-browser-item-main" onClick={() => setPreview(image)}>
                  <img src={apiUrl(image.thumbnail_url)} alt="" loading="lazy" />
                  <div>
                    <strong title={image.file_name}>{image.file_name}</strong>
                    <small>{formatSize(image.size_bytes)}{image.tags.length ? ` · ${image.tags.map((tag) => tag.name + (tag.value ? ":" + tag.value : "")).join("、")}` : ""}</small>
                  </div>
                </button>
                <button
                  type="button"
                  className={`source-browser-item-toggle${image.tags.length ? " tagged" : ""}`}
                  disabled={busy || !tags.length}
                  title={image.tags.length ? `取消标签：${image.tags.map((tag) => tag.name + (tag.value ? ":" + tag.value : "")).join("、")}` : (tags.length ? `打标签：${tags[0].name}` : "先创建标签")}
                  onClick={() => void toggleImageTag(image, image.tags[0] ?? tags[0])}
                >
                  {image.tags.length ? `✕ ${image.tags[0].name}${image.tags.length > 1 ? ` +${image.tags.length - 1}` : ""}` : (tags.length ? `+ ${tags[0].name}` : "无标签")}
                </button>
              </div>
            ))}
          </aside>
          <div className="source-browser-main">
            {preview ? (
              <>
                <img src={apiUrl(preview.file_url)} alt={preview.file_name} />
                <div className="source-browser-bar">
                  <span>{previewIndex >= 0 ? `${previewIndex + 1} / ${items.length}` : ""} · {preview.file_name}</span>
                  <span className="muted">{preview.width}×{preview.height} · {formatSize(preview.size_bytes)}</span>
                  <div>
                    <button className="button" onClick={() => stepPreview(-1)} title="上一张（A）">← 上一张</button>
                    <button className="button" onClick={() => stepPreview(1)} title="下一张（D）">下一张 →</button>
                  </div>
                </div>
                <div className="source-preview-tags" role="group" aria-label="图片标签">
                  {tags.length ? tags.map((tag) => {
                    const enabled = preview.tags.some((item) => item.id === tag.id);
                    const current = preview.tags.find((item) => item.id === tag.id);
                    return (
                      <span key={tag.id} className={`source-tag-chip enum${enabled ? " active" : ""}`} style={{ borderColor: tag.color }}>
                        <button type="button" disabled={busy} onClick={() => void toggleImageTag(preview, tag)}>{tag.name}{current?.value ? `:${current.value}` : ""}</button>
                        {tag.values && enabled && (
                          <select
                            aria-label={`${tag.name} 取值`}
                            value={current?.value ?? tag.values[0]}
                            disabled={busy}
                            onChange={(event) => void toggleImageTag(preview, tag, event.target.value)}
                          >
                            {tag.values.map((value) => <option key={value} value={value}>{value}</option>)}
                          </select>
                        )}
                      </span>
                    );
                  }) : <span className="muted">还没有标签。</span>}
                </div>
              </>
            ) : (
              <div className="source-browser-empty"><strong>点击左侧图片预览</strong><span>支持 A / D 或 ← / → 切换，Esc 关闭网格预览弹窗</span></div>
            )}
          </div>
        </section>
        )}
        </>
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
                    <span key={tag.id} className={`source-tag-chip enum${enabled ? " active" : ""}`} style={{ borderColor: tag.color }}>
                      <button type="button" onClick={() => setFtpTagIds((ids) => (ids.includes(tag.id) ? ids.filter((item) => item !== tag.id) : [...ids, tag.id]))}>{tag.name}</button>
                      {enabled && tag.values && (
                        <select aria-label={`${tag.name} 取值`} value={ftpTagValues[tag.id] ?? tag.values[0]} onChange={(event) => setFtpTagValues((prev) => ({ ...prev, [tag.id]: event.target.value }))}>
                          {tag.values.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      )}
                    </span>
                  );
                }) : <span className="muted">还没有标签，请到「设置 → 基础数据 → 标签库」维护。</span>}
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
                    <span key={tag.id} className={`source-tag-chip enum${enabled ? " active" : ""}`} style={{ borderColor: tag.color }}>
                      <button type="button" onClick={() => setUploadTagIds((ids) => (ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]))}>{tag.name}</button>
                      {enabled && tag.values && (
                        <select aria-label={`${tag.name} 取值`} value={uploadTagValues[tag.id] ?? tag.values[0]} onChange={(event) => setUploadTagValues((prev) => ({ ...prev, [tag.id]: event.target.value }))}>
                          {tag.values.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      )}
                    </span>
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

      {preview && viewMode === "grid" && (
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