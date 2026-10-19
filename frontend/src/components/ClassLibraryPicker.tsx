import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Toast } from "./Toast";
import type { ClassLabel, ClassTemplate } from "../types";

function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "操作失败，请检查后端服务。"; }

/** 标注页“从类别库选择”弹窗：勾选模板后导入当前数据集，同名类别会被跳过。 */
export function ClassLibraryPicker(props: {
  existingClasses: ClassLabel[];
  isSegment: boolean;
  busy: boolean;
  onImport: (templateIds: string[]) => Promise<ClassLabel[] | undefined>;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<ClassTemplate[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    api.listClassTemplates()
      .then((items) => {
        setTemplates(items);
        const existing = new Set(props.existingClasses.map((item) => item.name));
        setSelected(new Set(items.filter((item) => !existing.has(item.name)).map((item) => item.id)));
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
    // existingClasses 只在弹窗打开时关心一次快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const confirm = async () => {
    if (!selected.size) return;
    setImporting(true);
    setError("");
    try {
      const imported = await props.onImport([...selected]);
      if (imported) props.onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setImporting(false);
    }
  };

  const existingNames = new Set(props.existingClasses.map((item) => item.name));

  return <div className="modal-backdrop data-exchange-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section className="dataset-dialog data-exchange-dialog class-library-picker" role="dialog" aria-modal="true" aria-labelledby="class-library-picker-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="data-exchange-header"><div><span className="eyebrow">CLASS LIBRARY</span><h2 id="class-library-picker-title">从类别库导入类别</h2><p>勾选后导入当前数据集{props.isSegment ? "，实例分割任务会一并带入 SAM3 英文提示词" : ""}。</p></div><button className="icon-button" onClick={props.onClose} aria-label="关闭">×</button></header>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <div className="class-library-picker-list">
        {templates === undefined ? <p className="muted">加载中…</p> : !templates.length ? <p className="annotation-empty-state">类别库还是空的，请先在左侧“类别库”页面维护类别。</p> : templates.map((template) => {
          const duplicated = existingNames.has(template.name);
          return <label key={template.id} className={`class-library-picker-item${duplicated ? " duplicated" : ""}`}>
            <input type="checkbox" checked={duplicated ? false : selected.has(template.id)} disabled={duplicated} onChange={() => toggle(template.id)} />
            <i style={{ background: template.color }} />
            <span><strong>{template.name}</strong>{props.isSegment && (template.sam3_prompt ? <small>SAM3: {template.sam3_prompt}</small> : <small className="muted">未设置 SAM3 提示词</small>)}</span>
            {duplicated && <em>同名已存在</em>}
          </label>;
        })}
      </div>
      <footer className="data-exchange-footer"><span>已选 {selected.size} 个，同名类别会自动跳过。</span><div><button className="button" disabled={importing || props.busy} onClick={props.onClose}>取消</button><button className="button primary" disabled={importing || props.busy || !selected.size} onClick={() => void confirm()}>{importing ? "导入中…" : `导入 ${selected.size || ""} 个类别`}</button></div></footer>
    </section>
  </div>;
}
