import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Toast } from "../components/Toast";
import type { FtpEntry, FtpListResult } from "../types";

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "FTP 操作失败，请检查设置中的连接配置。";
}

function formatSize(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function FtpView() {
  const [result, setResult] = useState<FtpListResult>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renameTarget, setRenameTarget] = useState<FtpEntry>();
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FtpEntry>();
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const path = result?.path ?? "/";

  const load = async (next: string, quiet = false) => {
    if (!quiet) setLoading(true);
    if (!quiet) setError("");
    try {
      const payload = await api.listFtp(next);
      setResult(payload);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load("/");
  }, []);

  const runAction = async (action: () => Promise<string>) => {
    setBusy(true);
    setError("");
    try {
      setNotice(await action());
      await load(path, true);
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
      await api.uploadFtp(path, list);
      return `已上传 ${list.length} 个文件到 ${path}`;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const value = renameValue.trim();
    if (!value) return;
    const target = value.startsWith("/") ? value : `${path === "/" ? "" : path}/${value}`;
    const source = renameTarget.path;
    setRenameTarget(undefined);
    await runAction(async () => {
      await api.ftpRename(source, target);
      return `已移动到 ${target}`;
    });
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    const removed = deleteTarget;
    setDeleteTarget(undefined);
    await runAction(async () => {
      await api.ftpDelete(removed.path);
      return `已删除 ${removed.name}`;
    });
  };

  const submitMkdir = async () => {
    const name = mkdirName.trim();
    if (!name) return;
    setMkdirOpen(false);
    await runAction(async () => {
      const target = name.startsWith("/") ? name : `${path === "/" ? "" : path}/${name}`;
      await api.ftpMkdir(target);
      return `已创建目录 ${target}`;
    });
    setMkdirName("");
  };

  const crumbs = path === "/" ? [] : path.split("/").filter(Boolean);
  const entries = result?.entries ?? [];

  return (
    <main className="ftp-page">
      <header className="ftp-head">
        <div>
          <span className="eyebrow">FTP MANAGER</span>
          <h1>FTP 管理</h1>
          <p>浏览 FTP 服务器文件，支持上传、下载、移动与删除。连接凭据在“设置 → FTP 服务”中维护。</p>
        </div>
      </header>
      <Toast kind="error" message={error} onClose={() => setError("")} />
      <Toast kind="success" message={notice} onClose={() => setNotice("")} />
      <section className="panel ftp-browser">
        <div className="ftp-toolbar">
          <div className="header-actions ftp-toolbar-actions">
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
            <button className="button" disabled={busy || loading} onClick={() => fileInputRef.current?.click()}>上传文件</button>
            <button className="button" disabled={busy || loading} onClick={() => { setMkdirName(""); setMkdirOpen(true); }}>新建文件夹</button>
            <button className="button" disabled={busy || loading} onClick={() => void load(path)}>刷新</button>
          </div>
          <button className="button" disabled={busy || loading || path === "/"} onClick={() => void load(parentPath(path))}>返回上级</button>
          <nav className="ftp-breadcrumb" aria-label="FTP 路径">
            <button onClick={() => void load("/")}>/</button>
            {crumbs.map((crumb, index) => {
              const target = `/${crumbs.slice(0, index + 1).join("/")}`;
              return <span key={target}>/ <button onClick={() => void load(target)}>{crumb}</button></span>;
            })}
          </nav>
        </div>
        {loading ? (
          <p className="muted">正在读取目录…</p>
        ) : (
          <table className="ftp-table">
            <thead>
              <tr><th>名称</th><th>大小</th><th>修改时间</th><th className="ftp-actions-head">操作</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <button className={`ftp-name${entry.is_dir ? " dir" : ""}`} onClick={() => entry.is_dir && void load(entry.path)} title={entry.is_dir ? "打开目录" : entry.name}>
                      <span aria-hidden="true">{entry.is_dir ? "📁" : "📄"}</span>
                      <span>{entry.name}</span>
                    </button>
                  </td>
                  <td>{formatSize(entry.size)}</td>
                  <td>{entry.modified ?? "—"}</td>
                  <td className="ftp-actions">
                    {!entry.is_dir && <a className="button" href={api.ftpDownloadUrl(entry.path)}>下载</a>}
                    <button className="button" disabled={busy} onClick={() => { setRenameTarget(entry); setRenameValue(entry.name); }}>移动/重命名</button>
                    <button className="button danger" disabled={busy} onClick={() => setDeleteTarget(entry)}>删除</button>
                  </td>
                </tr>
              ))}
              {!entries.length && <tr><td colSpan={4} className="muted ftp-empty">此目录为空。</td></tr>}
            </tbody>
          </table>
        )}
      </section>

      {mkdirOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setMkdirOpen(false)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="ftp-mkdir-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">NEW FOLDER</span><h2 id="ftp-mkdir-title">在 {path} 下新建文件夹</h2><p>可填写名称，或以 / 开头的绝对路径。</p></div><button className="icon-button" onClick={() => setMkdirOpen(false)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitMkdir(); }}>
              <input autoFocus value={mkdirName} placeholder="例如：datasets" onChange={(event) => setMkdirName(event.target.value)} />
              <footer>
                <button type="button" className="button" onClick={() => setMkdirOpen(false)}>取消</button>
                <button className="button primary" type="submit" disabled={!mkdirName.trim()}>创建</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {renameTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRenameTarget(undefined)}>
          <section className="dataset-dialog" role="dialog" aria-modal="true" aria-labelledby="ftp-rename-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="data-exchange-header"><div><span className="eyebrow">MOVE / RENAME</span><h2 id="ftp-rename-title">移动或重命名 {renameTarget.name}</h2><p>填写新名称（当前目录内），或以 / 开头的绝对路径移动到其他位置。</p></div><button className="icon-button" onClick={() => setRenameTarget(undefined)} aria-label="关闭">×</button></header>
            <form className="ftp-dialog-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
              <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
              <footer>
                <button type="button" className="button" onClick={() => setRenameTarget(undefined)}>取消</button>
                <button className="button primary" type="submit" disabled={!renameValue.trim()}>确认</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeleteTarget(undefined)}>
          <section className="dataset-dialog dataset-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ftp-delete-title" aria-describedby="ftp-delete-description" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">DELETE</span><h2 id="ftp-delete-title">删除 {deleteTarget.is_dir ? "目录" : "文件"}“{deleteTarget.name}”？</h2><p id="ftp-delete-description">{deleteTarget.is_dir ? "目录及其全部内容会被递归删除，此操作不可恢复。" : "文件删除后不可恢复。"}</p></div><button className="icon-button" onClick={() => setDeleteTarget(undefined)} aria-label="关闭">×</button></header>
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
