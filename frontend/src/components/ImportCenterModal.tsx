import { useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import { VideoImportContent } from "./VideoImportModal";
import type { FtpEntry, TaskType, VideoImportTask } from "../types";

type ImportSource = "yolo" | "coco" | "video";

const SOURCES: Array<{ id: ImportSource; icon: string; title: string; detail: string }> = [
  { id: "yolo", icon: "▣", title: "YOLO 数据集", detail: "ZIP · data.yaml、images、labels" },
  { id: "coco", icon: "◎", title: "COCO 数据集", detail: "ZIP · annotations.json 与 images" },
  { id: "video", icon: "▶", title: "视频文件", detail: "MP4、MOV、AVI · 预检后抽帧" },
];

export function ImportCenterModal({
  busy,
  onClose,
  onArchiveImport,
  onFtpImport,
  onVideoCompleted,
}: {
  busy: boolean;
  onClose: () => void;
  onArchiveImport: (file: File, name: string, taskType: TaskType, format: "yolo" | "coco") => void;
  onFtpImport: (path: string, name: string, taskType: TaskType, format: "yolo" | "coco") => void;
  onVideoCompleted: (task: VideoImportTask) => Promise<void> | void;
}) {
  const [source, setSource] = useState<ImportSource>("yolo");
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("detect");
  const [archive, setArchive] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [origin, setOrigin] = useState<"local" | "ftp">("local");
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpEntries, setFtpEntries] = useState<FtpEntry[]>();
  const [ftpError, setFtpError] = useState("");
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpSelected, setFtpSelected] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSource = SOURCES.find((item) => item.id === source)!;

  const browseFtp = (path: string) => {
    setFtpLoading(true);
    setFtpError("");
    api.listFtp(path).then((result) => {
      setFtpPath(result.path);
      setFtpEntries(result.entries);
    }).catch((reason) => {
      setFtpEntries(undefined);
      setFtpError(reason instanceof Error ? reason.message : "无法读取 FTP 目录。");
    }).finally(() => setFtpLoading(false));
  };

  useEffect(() => {
    if (origin === "ftp" && ftpEntries === undefined && !ftpLoading && !ftpError) browseFtp(ftpPath);
  }, [origin]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseSource = (next: ImportSource) => {
    setSource(next);
    setArchive(undefined);
    setDragging(false);
  };
  const importArchive = () => {
    if (!name.trim() || source === "video") return;
    if (origin === "ftp") {
      if (!ftpSelected) return;
      onFtpImport(ftpSelected, name.trim(), taskType, source);
    } else {
      if (!archive) return;
      onArchiveImport(archive, name.trim(), taskType, source);
    }
    onClose();
  };
  const canImport = name.trim() && (origin === "ftp" ? Boolean(ftpSelected) : Boolean(archive));
  // 名称容易在浏览文件时被漏填；为空时用所选 zip 文件名兜底，不覆盖用户输入。
  const applyDefaultName = (fileName: string) => {
    if (!name.trim()) setName(fileName.replace(/\.zip$/i, ""));
  };
  const parentOf = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    return index <= 0 ? "/" : trimmed.slice(0, index);
  };

  return <div className="modal-backdrop data-exchange-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="dataset-dialog data-exchange-dialog import-center-dialog" role="dialog" aria-modal="true" aria-labelledby="import-center-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="data-exchange-header"><div><span className="eyebrow">IMPORT CENTER</span><h2 id="import-center-title">导入数据</h2><p>选择数据来源。视频会先预检，确认后才在本机后台抽帧创建数据集。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      <div className="import-center-layout">
        <aside className="import-center-sources" aria-label="导入来源">
          <span className="exchange-label">导入来源</span>
          {SOURCES.map((item) => <button key={item.id} type="button" className={source === item.id ? "import-source-option selected" : "import-source-option"} onClick={() => chooseSource(item.id)}><span className="import-source-icon" aria-hidden>{item.icon}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}
        </aside>
        <section className="import-center-panel">
          {source === "video" ? <VideoImportContent onClose={onClose} onCompleted={onVideoCompleted} /> : <>
            <div className="import-center-step"><span>1</span><div><strong>{activeSource.title}</strong><p>{activeSource.detail}</p></div></div>
            <div className="exchange-fields"><label>数据集名称<input value={name} placeholder="例如：road-signs" onChange={(event) => setName(event.target.value)} autoFocus /></label><label>任务类型<select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)}><option value="detect">目标检测（Bounding Box）</option><option value="segment">实例分割（Polygon / SAM）</option><option value="obb">旋转框（OBB）</option><option value="classify">图像分类</option></select></label></div>
            <div className="import-origin-toggle" role="group" aria-label="文件来源">
              <button type="button" className={origin === "local" ? "active" : ""} onClick={() => setOrigin("local")}>本机文件</button>
              <button type="button" className={origin === "ftp" ? "active" : ""} onClick={() => setOrigin("ftp")}>FTP 选择</button>
            </div>
            {origin === "local" ? <>
              <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; setArchive(file); if (file) applyDefaultName(file.name); event.currentTarget.value = ""; }} />
              <button type="button" className={dragging ? "exchange-dropzone dragging" : "exchange-dropzone"} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); setArchive(event.dataTransfer.files[0]); if (event.dataTransfer.files[0]) applyDefaultName(event.dataTransfer.files[0].name); }}><span className="exchange-dropzone-icon">⇧</span><strong>{archive?.name ?? `拖放或选择 ${source.toUpperCase()} ZIP 文件`}</strong><small>{archive ? `${Math.ceil(archive.size / 1024)} KB · 已准备导入` : source === "yolo" ? "ZIP 内应包含 data.yaml、images 和 labels" : "ZIP 内应包含 annotations.json/instances.json 与 images"}</small></button>
            </> : (
              <div className="import-ftp-picker">
                <div className="import-ftp-toolbar">
                  <button type="button" className="button" disabled={ftpLoading || ftpPath === "/"} onClick={() => browseFtp(parentOf(ftpPath))}>↑ 上级</button>
                  <input value={ftpPath} aria-label="FTP 路径" onChange={(event) => setFtpPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") browseFtp(ftpPath); }} />
                  <button type="button" className="button" disabled={ftpLoading} onClick={() => browseFtp(ftpPath)}>浏览</button>
                </div>
                <div className="import-ftp-list">
                  {ftpLoading && <p className="muted">正在读取目录…</p>}
                  {ftpError && <p className="annotation-form-error">{ftpError}（请先在「FTP 管理」页配置连接）</p>}
                  {!ftpLoading && !ftpError && ftpEntries?.map((entry) => entry.is_dir
                    ? <button key={entry.name} type="button" className="import-ftp-row dir" onClick={() => browseFtp(`${ftpPath.replace(/\/+$/, "")}/${entry.name}`)}><span>📁</span><strong>{entry.name}</strong><small>目录</small></button>
                    : <button key={entry.name} type="button" disabled={!entry.name.toLowerCase().endsWith(".zip")} className={`import-ftp-row file${ftpSelected === `${ftpPath.replace(/\/+$/, "")}/${entry.name}` ? " selected" : ""}`} onClick={() => { setFtpSelected(`${ftpPath.replace(/\/+$/, "")}/${entry.name}`); applyDefaultName(entry.name); }}><span>🗜</span><strong>{entry.name}</strong><small>{entry.size != null ? `${Math.ceil(entry.size / 1024)} KB` : ""}</small></button>)}
                  {!ftpLoading && !ftpError && ftpEntries && !ftpEntries.some((entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(".zip")) && <p className="muted">当前目录没有 .zip 文件。</p>}
                </div>
                {ftpSelected && <p className="import-ftp-selected">已选择:{ftpSelected}</p>}
              </div>
            )}
            <footer className="data-exchange-footer"><span>{origin === "ftp" ? "后端会从 FTP 下载所选 ZIP 并导入本机受管目录。" : "文件仅导入到本机受管数据目录。"}</span><div><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !canImport} onClick={importArchive}>开始导入</button></div></footer>
          </>}
        </section>
      </div>
    </section>
  </div>;
}
