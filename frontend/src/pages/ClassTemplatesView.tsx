import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import type { ClassTemplate } from "../types";

const CLASS_COLORS = ["#22c55e", "#ef4444", "#3b82f6", "#f59e0b", "#a855f7", "#14b8a6", "#f97316", "#06b6d4", "#ec4899"];

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
        <label><span>颜色</span><input aria-label="类别颜色" type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
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
                <label><span>颜色</span><input aria-label="类别颜色" type="color" value={editState.color} onChange={(event) => setEditState({ ...editState, color: event.target.value })} /></label>
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
