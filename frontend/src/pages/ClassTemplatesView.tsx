import { useEffect, useState, type FormEvent } from "react";
import { App as AntdApp, Button as AntdButton, Form as AntdForm, Input as AntdInput, Modal, Popconfirm, Table, type TableProps } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import type { ClassTemplate, MaterialType, TagTemplate } from "../types";

type LibraryTab = "classes" | "tags" | "materials";

const CLASS_COLORS = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#14b8a6", "#f97316", "#06b6d4", "#ec4899", "#84cc16",
  "#6366f1", "#eab308", "#10b981", "#f43f5e", "#0ea5e9",
  "#8b5cf6", "#d946ef", "#facc15", "#4ade80", "#fb923c",
];

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。"; }

/** 翻译接口未产出提示词时，按 source 给出可操作的提示。 */
export function sam3TranslateMessage(result: { sam3_prompt: string | null; source: string }): string {
  if (result.sam3_prompt) return "";
  if (result.source === "llm_failed") return "LLM 翻译调用失败，请到设置页检查 LLM 连接，或手动填写英文提示词。";
  if (result.source === "llm_invalid") return "LLM 返回的内容不是有效的英文提示词，请手动填写。";
  return "自动翻译暂不可用（内置词典未覆盖且未配置可用 LLM），请手动填写英文提示词。";
}

type EditState = { id: string; name: string; color: string; sam3Prompt: string } | null;

export function ClassTemplatesView() {
  const [tab, setTab] = useState<LibraryTab>("classes");
  return (
    <main className="class-library-page">
      <header className="dataset-home-header">
        <div>
          <h1>基础数据管理</h1>
          <p>维护全局类别库与标签库;数据集导入类别、数据源打标签都从这里取数。标签支持枚举取值(如 光线=强/弱)。</p>
        </div>
      </header>
      <div className="import-origin-toggle base-data-tabs" role="tablist" aria-label="基础数据">
        <button type="button" role="tab" aria-selected={tab === "classes"} className={tab === "classes" ? "active" : ""} onClick={() => setTab("classes")}>类别库</button>
        <button type="button" role="tab" aria-selected={tab === "tags"} className={tab === "tags" ? "active" : ""} onClick={() => setTab("tags")}>标签库</button>
        <button type="button" role="tab" aria-selected={tab === "materials"} className={tab === "materials" ? "active" : ""} onClick={() => setTab("materials")}>素材类型</button>
      </div>
      {tab === "classes" ? <ClassLibraryPanel /> : tab === "tags" ? <TagLibraryPanel /> : <MaterialTypePanel />}
    </main>
  );
}

function ClassLibraryPanel() {
  const [templates, setTemplates] = useState<ClassTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(CLASS_COLORS[0]);
  const [sam3Prompt, setSam3Prompt] = useState("");
  const [translating, setTranslating] = useState(false);
  const [editState, setEditState] = useState<EditState>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClassTemplate>();

  useEffect(() => {
    api.listClassTemplates()
      .then(setTemplates)
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, []);

  const resetForm = () => {
    setName("");
    setColor(CLASS_COLORS[templates.length % CLASS_COLORS.length]);
    setSam3Prompt("");
    setShowForm(false);
  };

  const autoTranslate = async () => {
    const source = (editState ? editState.name : name).trim();
    if (!source) return;
    setTranslating(true);
    setError("");
    try {
      const result = await api.translateSam3Prompt(source);
      if (editState) setEditState({ ...editState, sam3Prompt: result.sam3_prompt ?? "" });
      else setSam3Prompt(result.sam3_prompt ?? "");
      const message = sam3TranslateMessage(result);
      setNotice(message);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTranslating(false);
    }
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createClassTemplate({ name: trimmed, color, ...(sam3Prompt.trim() ? { sam3_prompt: sam3Prompt.trim() } : {}) });
      setTemplates((items) => [...items, created]);
      setNotice(`已新增类别“${created.name}”${created.sam3_prompt ? `（SAM3 提示词：${created.sam3_prompt}）` : ""}`);
      resetForm();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editState) return;
    const trimmed = editState.name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.updateClassTemplate(editState.id, { name: trimmed, color: editState.color, sam3_prompt: editState.sam3Prompt.trim() || undefined });
      setTemplates((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setNotice(`类别“${updated.name}”已更新`);
      setEditState(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteClassTemplate(deleteTarget.id);
      setTemplates((items) => items.filter((item) => item.id !== deleteTarget.id));
      setNotice(`类别“${deleteTarget.name}”已从类别库删除（数据集中的既有类别不受影响）`);
      setDeleteTarget(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (template: ClassTemplate) => {
    setEditState({ id: template.id, name: template.name, color: template.color, sam3Prompt: template.sam3_prompt ?? "" });
    setShowForm(false);
  };

  return <main className="class-library-page">
    <header className="dataset-home-header">
      <div><h1>类别库</h1><p>维护可复用的标注类别。实例分割任务导入类别时会带上 SAM3 英文提示词，供远程 SAM3 文本提示使用。</p></div>
      <div className="header-actions"><button className="button primary" onClick={() => { resetForm(); setShowForm((value) => !value); }}>{showForm ? "收起" : "+ 新增类别"}</button></div>
    </header>
    <Toast kind="error" message={error} onClose={() => setError("")} />
    <Toast kind="success" message={notice} onClose={() => setNotice("")} />
    {showForm && <form className="class-library-form panel" onSubmit={(event) => void submitCreate(event)}>
      <div className="class-library-form-grid">
        <label><span>类别名称 *</span><input value={name} placeholder="例如：安全帽 / helmet" autoFocus onChange={(event) => setName(event.target.value)} /></label>
        <label><span>颜色</span><div className="class-color-palette" role="radiogroup" aria-label="类别颜色">{CLASS_COLORS.map((item) => <button type="button" key={item} role="radio" aria-checked={color === item} className={`class-color-swatch${color === item ? " selected" : ""}`} style={{ background: item }} onClick={() => setColor(item)} aria-label={item} />)}</div></label>
      </div>
      <label className="class-library-prompt-row"><span>SAM3 英文提示词（实例分割可选）</span>
        <div className="class-library-prompt-controls">
          <input value={sam3Prompt} placeholder="例如：helmet，留空则按名称自动生成" onChange={(event) => setSam3Prompt(event.target.value)} />
          <button type="button" className="button" disabled={translating || !name.trim()} onClick={() => void autoTranslate()}>{translating ? "翻译中…" : "自动翻译"}</button>
        </div>
      </label>
      <footer><span className="muted">英文类名可直接作为提示词；中文类名会先用内置词典，再尝试已配置的 LLM 翻译。</span><button className="button primary" type="submit" disabled={busy || !name.trim()}>添加</button></footer>
    </form>}
    <section className="dataset-overview">
      <div className="section-title-row"><div><span className="eyebrow">CLASS LIBRARY</span><h2>全部类别</h2></div><span className="dataset-total">{templates.length} 个类别</span></div>
      {loading ? <p className="muted">加载中…</p> : !templates.length ? <section className="dataset-empty-card"><span className="dataset-empty-icon">◇</span><h2>类别库还是空的</h2><p>先在这里沉淀常用类别，标注时即可一键导入数据集，不必每个数据集重复录入。</p></section> : <div className="class-library-grid">
        {templates.map((template) => <article key={template.id} className="class-library-card">
          {editState?.id === template.id ? (
            <form className="class-library-edit-form" onSubmit={(event) => void submitEdit(event)}>
              <div className="class-library-form-grid">
                <label><span>类别名称</span><input value={editState.name} autoFocus onChange={(event) => setEditState({ ...editState, name: event.target.value })} /></label>
                <label><span>颜色</span><div className="class-color-palette" role="radiogroup" aria-label="类别颜色">{CLASS_COLORS.map((item) => <button type="button" key={item} role="radio" aria-checked={editState.color === item} className={`class-color-swatch${editState.color === item ? " selected" : ""}`} style={{ background: item }} onClick={() => setEditState({ ...editState, color: item })} aria-label={item} />)}</div></label>
              </div>
              <label className="class-library-prompt-row"><span>SAM3 英文提示词</span>
                <div className="class-library-prompt-controls">
                  <input value={editState.sam3Prompt} placeholder="例如：helmet" onChange={(event) => setEditState({ ...editState, sam3Prompt: event.target.value })} />
                  <button type="button" className="button" disabled={translating || !editState.name.trim()} onClick={() => void autoTranslate()}>{translating ? "翻译中…" : "自动翻译"}</button>
                </div>
              </label>
              <div className="class-library-edit-actions"><button type="button" className="button" disabled={busy} onClick={() => setEditState(null)}>取消</button><button className="button primary" type="submit" disabled={busy || !editState.name.trim()}>保存</button></div>
            </form>
          ) : (
            <>
              <header><i style={{ background: template.color }} /><h3>{template.name}</h3></header>
              <p className="class-library-prompt" title={template.sam3_prompt ?? undefined}>
                <span>SAM3</span>
                {template.sam3_prompt ? <code>{template.sam3_prompt}</code> : <small className="muted">未设置英文提示词</small>}
              </p>
              <footer><button className="button" disabled={busy} onClick={() => startEdit(template)}>编辑</button><button className="button class-library-delete" disabled={busy} onClick={() => setDeleteTarget(template)}>删除</button></footer>
            </>
          )}
        </article>)}
      </div>}
    </section>
    {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
      <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="class-template-delete-title" aria-describedby="class-template-delete-description" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">DELETE CLASS</span><h2 id="class-template-delete-title">删除类别“{deleteTarget.name}”？</h2><p id="class-template-delete-description">只从类别库移除模板，已导入数据集的类别和标注不受影响。</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
        <footer><button className="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</button><button className="button danger" disabled={busy} onClick={() => void confirmDelete()}>确认删除</button></footer>
      </section>
    </div>}
  </main>;
}

const TAG_COLORS = CLASS_COLORS;

function formatTagTime(value: string): string {
  return value ? value.slice(0, 19).replace("T", " ") : "—";
}

function TagLibraryPanel() {
  const [tags, setTags] = useState<TagTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLORS[0]);
  const [valuesInput, setValuesInput] = useState("");
  const [description, setDescription] = useState("");
  const [editState, setEditState] = useState<{ id: string; name: string; color: string; values: string; description: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagTemplate>();

  const refresh = () => api.listTagTemplates().then(setTags).catch((reason: unknown) => setError(errorMessage(reason)));
  useEffect(() => { refresh().finally(() => setLoading(false)); }, []);

  const parseValues = (raw: string) => raw.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean);

  const openCreate = () => {
    setEditState(null);
    setName(""); setColor(TAG_COLORS[tags.length % TAG_COLORS.length]); setValuesInput(""); setDescription("");
    setDialogOpen(true);
  };

  const openEdit = (tag: TagTemplate) => {
    setEditState({ id: tag.id, name: tag.name, color: tag.color, values: (tag.values ?? []).join(", "), description: tag.description ?? "" });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (busy) return;
    setDialogOpen(false);
    setEditState(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = (editState ? editState.name : name).trim();
    if (!trimmed) return;
    const values = parseValues(editState ? editState.values : valuesInput);
    setBusy(true); setError(""); setNotice("");
    try {
      if (editState) {
        await api.updateTagTemplate(editState.id, { name: trimmed, color: editState.color, values: values.length ? values : null, description: (editState.description || "").trim() || null });
        setNotice(`标签“${trimmed}”已更新`);
      } else {
        await api.createTagTemplate({ name: trimmed, color, values: values.length ? values : null, description: description.trim() || null });
        setNotice(`已新增标签“${trimmed}”`);
      }
      setEditState(null); setDialogOpen(false);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setBusy(false); }
  };

  const remove = async (tag: TagTemplate) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.deleteTagTemplate(tag.id);
      setNotice(`已删除标签“${tag.name}”`);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setBusy(false); setDeleteTarget(undefined); }
  };

  return (
    <>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      <div className="header-actions">
        <button className="button primary" onClick={openCreate}>+ 新增标签</button>
      </div>

      {loading ? <p className="muted">正在加载标签库…</p> : tags.length ? (
        <div className="model-table-wrap">
          <table className="model-table tag-library-table">
            <thead>
              <tr>
                <th className="model-table-check"></th>
                <th>标签</th>
                <th>枚举取值</th>
                <th>备注</th>
                <th>更新时间</th>
                <th className="model-table-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={tag.id}>
                  <td className="model-table-check"><i className="tag-color-dot" style={{ background: tag.color }} /></td>
                  <td className="model-table-name"><button type="button" title={tag.name}>{tag.name}</button></td>
                  <td>{tag.values?.length ? <div className="tag-values-cell">{tag.values.map((value) => <em key={value}>{value}</em>)}</div> : <span className="muted">—</span>}</td>
                  <td title={tag.description ?? undefined}>{tag.description || <span className="muted">—</span>}</td>
                  <td className="model-table-time">{formatTagTime(tag.updated_at)}</td>
                  <td className="model-table-actions">
                    <button className="model-action-btn model-action-btn--ghost" disabled={busy} onClick={() => openEdit(tag)}>编辑</button>
                    <button className="model-action-btn model-action-btn--danger" disabled={busy} onClick={() => setDeleteTarget(tag)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">标签库还是空的。新增标签(如“光线=强/弱”)后,数据源打标界面会直接使用。</p>}

      {dialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeDialog}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">{editState ? "EDIT TAG" : "NEW TAG"}</span><h2 id="tag-dialog-title">{editState ? "编辑标签" : "新增标签"}</h2></div>
              <button className="icon-button" onClick={closeDialog} aria-label="关闭">×</button>
            </header>
            <form className="tag-dialog-form" onSubmit={(event) => void submit(event)}>
              <label><span>标签名</span><input autoFocus value={editState ? editState.name : name} placeholder="例如：光线" onChange={(event) => (editState ? setEditState({ ...editState, name: event.target.value }) : setName(event.target.value))} /></label>
              <label><span>颜色</span>
                <div className="class-color-palette" role="radiogroup" aria-label="标签颜色">
                  {TAG_COLORS.map((item) => (
                    <button type="button" key={item} role="radio" aria-checked={(editState ? editState.color : color) === item} className={`class-color-swatch${(editState ? editState.color : color) === item ? " selected" : ""}`} style={{ background: item }} onClick={() => (editState ? setEditState({ ...editState, color: item }) : setColor(item))} aria-label={item} />
                  ))}
                </div>
              </label>
              <label><span>枚举取值<small>选填,逗号/顿号分隔。填写后打标时可选具体取值(如 强/弱)。</small></span><input value={editState ? editState.values : valuesInput} placeholder="例如：强, 弱" onChange={(event) => (editState ? setEditState({ ...editState, values: event.target.value }) : setValuesInput(event.target.value))} /></label>
              <label><span>备注</span><input value={editState ? editState.description : description} placeholder="选填" onChange={(event) => (editState ? setEditState({ ...editState, description: event.target.value }) : setDescription(event.target.value))} /></label>
              <footer>
                <button type="button" className="button" disabled={busy} onClick={closeDialog}>取消</button>
                <button className="button primary" type="submit" disabled={busy || !(editState ? editState.name : name).trim()}>保存</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
          <section className="dataset-dialog" role="alertdialog" aria-modal="true">
            <header><div><span className="eyebrow">DELETE TAG</span><h2>删除标签“{deleteTarget.name}”？</h2><p>只删除标签库模板;数据源已使用的标签和图片标注不受影响。</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
            <footer>
              <button className="button" onClick={() => setDeleteTarget(undefined)}>取消</button>
              <button className="button danger" disabled={busy} onClick={() => void remove(deleteTarget)}>确认删除</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function MaterialTypePanel() {
  const { message } = AntdApp.useApp();
  const [types, setTypes] = useState<MaterialType[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialType | null>(null);
  const [form] = AntdForm.useForm<{ name: string; description?: string }>();

  const refresh = () =>
    api.listMaterialTypes()
      .then(setTypes)
      .catch((reason: unknown) => message.error(errorMessage(reason)))
      .finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setDialogOpen(true);
  };

  const openEdit = (item: MaterialType) => {
    setEditing(item);
    form.setFieldsValue({ name: item.name, description: item.description ?? "" });
    setDialogOpen(true);
  };

  const submit = async (values: { name: string; description?: string }) => {
    const description = values.description?.trim() || null;
    try {
      if (editing) {
        await api.updateMaterialType(editing.id, { name: values.name.trim(), description });
        message.success(`素材类型“${values.name.trim()}”已更新`);
      } else {
        await api.createMaterialType({ name: values.name.trim(), description });
        message.success(`已新增素材类型“${values.name.trim()}”`);
      }
      setDialogOpen(false);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const remove = async (item: MaterialType) => {
    try {
      await api.deleteMaterialType(item.id);
      message.success(`已删除素材类型“${item.name}”（数据源上的引用已同步清理）`);
      await refresh();
    } catch (reason) {
      message.error(errorMessage(reason));
    }
  };

  const columns: TableProps<MaterialType>["columns"] = [
    { title: "素材类型", dataIndex: "name", key: "name" },
    { title: "备注", dataIndex: "description", key: "description", render: (value: string | null) => value || <span className="muted">—</span> },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 180, render: (value: string) => formatTagTime(value) },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_, item) => (
        <>
          <AntdButton type="link" size="small" onClick={() => openEdit(item)}>编辑</AntdButton>
          <Popconfirm title={`删除素材类型“${item.name}”？`} description="数据源上已选择的该类型会同步移除。" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void remove(item)}>
            <AntdButton type="link" size="small" danger>删除</AntdButton>
          </Popconfirm>
        </>
      ),
    },
  ];

  return (
    <>
      <div className="header-actions" style={{ justifyContent: "flex-end" }}>
        <AntdButton type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增素材类型</AntdButton>
      </div>
      <Table<MaterialType>
        rowKey="id"
        columns={columns}
        dataSource={types}
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: "素材类型库还是空的。新增类型（如“可见光图片 / 红外视频”）后，数据源即可多选打标。" }}
      />
      <Modal
        title={editing ? "编辑素材类型" : "新增素材类型"}
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        cancelText="取消"
        okText="保存"
        okButtonProps={{ autoFocus: true }}
        destroyOnHidden
        onOk={() => void form.submit()}
        confirmLoading={false}
      >
        <AntdForm form={form} layout="vertical" onFinish={(values) => void submit(values)} style={{ marginTop: 12 }}>
          <AntdForm.Item name="name" label="类型名称" rules={[{ required: true, message: "请输入类型名称" }, { max: 255, message: "名称过长" }]}>
            <AntdInput placeholder="例如：可见光图片" autoFocus />
          </AntdForm.Item>
          <AntdForm.Item name="description" label="备注">
            <AntdInput placeholder="选填" />
          </AntdForm.Item>
        </AntdForm>
      </Modal>
    </>
  );
}
