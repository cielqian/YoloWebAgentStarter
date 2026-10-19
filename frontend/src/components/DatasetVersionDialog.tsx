import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Dataset, DatasetVersion } from "../types";

const formatTime = (value: string) => new Date(value).toLocaleString();

export function DatasetVersionDialog({ dataset, onClose, onChanged }: { dataset: Dataset; onClose: () => void; onChanged: () => void }) {
  const [versions, setVersions] = useState<DatasetVersion[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [switchTarget, setSwitchTarget] = useState<DatasetVersion>();

  const activeVersion = versions?.find((item) => item.is_active);

  const reload = async () => {
    try {
      setVersions(await api.listDatasetVersions(dataset.id));
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "加载版本失败");
      setVersions([]);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      await api.createDatasetVersion(dataset.id, note);
      setNote("");
      await reload();
      onChanged();
    });

  const skippedSuffix = (skipped: number) => (skipped ? `，${skipped} 张因文件缺失被跳过` : "");

  const activate = (version: DatasetVersion) =>
    run(async () => {
      const result = await api.activateDatasetVersion(dataset.id, version.id);
      await reload();
      onChanged();
      setNotice(`已激活 v${version.version_number}：恢复 ${result.restored_images} 张图片` + skippedSuffix(result.skipped_images));
    });

  const archiveAndActivate = (version: DatasetVersion) =>
    run(async () => {
      try {
        const archived = await api.createDatasetVersion(dataset.id, "切换前自动归档");
        const result = await api.activateDatasetVersion(dataset.id, version.id);
        onChanged();
        setNotice(
          `已归档为 v${archived.version_number} 并激活 v${version.version_number}：恢复 ${result.restored_images} 张图片` +
            skippedSuffix(result.skipped_images),
        );
      } finally {
        await reload();
      }
    });

  const beginSwitch = (version: DatasetVersion) => {
    if (activeVersion?.has_pending_changes) {
      setSwitchTarget(version);
      return;
    }
    void activate(version);
  };

  const remove = (version: DatasetVersion) =>
    run(async () => {
      await api.deleteDatasetVersion(dataset.id, version.id);
      setConfirmDeleteId(undefined);
      await reload();
      onChanged();
    });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="dataset-version-dialog" role="dialog" aria-modal="true" aria-label="数据集版本管理" onMouseDown={(event) => event.stopPropagation()}>
        <header className="data-exchange-header">
          <div>
            <span className="eyebrow">DATASET VERSIONS</span>
            <h2>版本管理 · {dataset.name}</h2>
            <p>新建版本会把当前图片、类别与标注归档为快照；激活中的版本显示当前工作区数据，激活历史版本可把工作区回滚到该快照。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="dataset-version-create">
          <label>
            版本备注
            <input value={note} placeholder="例如：修复了 20 张漏标" onChange={(event) => setNote(event.target.value)} disabled={busy} />
          </label>
          <button className="button primary" disabled={busy} onClick={() => void create()}>新建版本（快照当前数据）</button>
        </div>
        {error && <p className="validation invalid"><span>{error}</span></p>}
        {notice && <p className="dataset-version-notice">{notice}</p>}
        {switchTarget && (
          <div className="dataset-version-switch" role="alert">
            <p>
              当前激活的 v{activeVersion?.version_number} 有未归档改动，切换到 v{switchTarget.version_number}{" "}
              将丢失这些改动。可先归档当前工作区（会生成一个新版本），再执行切换。
            </p>
            <div className="dataset-version-switch-actions">
              <button className="button primary" disabled={busy} onClick={() => { setSwitchTarget(undefined); void archiveAndActivate(switchTarget); }}>
                归档并切换
              </button>
              <button className="button danger" disabled={busy} onClick={() => { setSwitchTarget(undefined); void activate(switchTarget); }}>
                放弃改动并切换
              </button>
              <button className="button" disabled={busy} onClick={() => setSwitchTarget(undefined)}>
                取消
              </button>
            </div>
          </div>
        )}
        <div className="dataset-version-list">
          {versions === null ? (
            <p className="muted">加载中…</p>
          ) : !versions.length ? (
            <p className="muted">还没有版本。标注到合适的节点后，新建一个版本作为回滚点。</p>
          ) : (
            versions.map((version) => (
              <div key={version.id} className={`dataset-version-row${version.is_active ? " active" : ""}`}>
                <span className="dataset-version-badge">v{version.version_number}</span>
                <div className="dataset-version-meta">
                  <strong>
                    {version.note || "（无备注）"}
                    {version.is_active ? <span className="status ready">激活中</span> : null}
                    {version.is_active && version.has_pending_changes ? <span className="dataset-version-pending">有未归档改动</span> : null}
                  </strong>
                  <small>
                    {version.image_count} 张图片 · {version.annotation_count} 条标注 · {version.class_count} 个类别 · {formatTime(version.created_at)}
                  </small>
                </div>
                <div className="dataset-version-actions">
                  {!version.is_active && <button className="button" disabled={busy} onClick={() => beginSwitch(version)}>激活</button>}
                  {!version.is_active &&
                    (confirmDeleteId === version.id ? (
                      <button className="button danger" disabled={busy} onClick={() => void remove(version)}>确认删除</button>
                    ) : (
                      <button className="button" disabled={busy} onClick={() => setConfirmDeleteId(version.id)}>删除</button>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
