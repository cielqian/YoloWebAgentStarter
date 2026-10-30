import { useEffect, useRef, useState } from "react";
import { Button as AntdButton, Col, Flex, Form, Input as AntdInput, Modal, Row, Segmented, Select as AntdSelect, Space, Space as AntdSpace, Tabs, Typography } from "antd";

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
  onArchiveImport: (file: File, name: string, taskType: TaskType, format: "yolo" | "coco", modelName?: string) => void;
  onFtpImport: (path: string, name: string, taskType: TaskType, format: "yolo" | "coco", source: "zip" | "dir", modelName?: string) => void;
  onVideoCompleted: (task: VideoImportTask) => Promise<void> | void;
}) {
  const [source, setSource] = useState<ImportSource>("yolo");
  const [name, setName] = useState("");
  const [modelName, setModelName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("detect");
  const [archive, setArchive] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [origin, setOrigin] = useState<"local" | "ftp">("local");
  const [ftpPath, setFtpPath] = useState("/");
  const [ftpEntries, setFtpEntries] = useState<FtpEntry[]>();
  const [ftpError, setFtpError] = useState("");
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpSelected, setFtpSelected] = useState("");
  const [ftpKind, setFtpKind] = useState<"zip" | "dir">("zip");
  const inputRef = useRef<HTMLInputElement>(null);

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
    // COCO 交换不支持 pose；切来源时把 pose 重置回默认，避免隐藏值提交。
    if (next === "coco" && taskType === "pose") setTaskType("detect");
  };
  const importArchive = () => {
    if (!name.trim() || source === "video") return;
    if (origin === "ftp") {
      if (!ftpSelected) return;
      onFtpImport(ftpSelected, name.trim(), taskType, source, ftpKind, modelName.trim() || undefined);
    } else {
      if (!archive) return;
      onArchiveImport(archive, name.trim(), taskType, source, modelName.trim() || undefined);
    }
    onClose();
  };
  const canImport = name.trim() && !(source === "coco" && taskType === "pose") && (origin === "ftp" ? Boolean(ftpSelected) : Boolean(archive));
  // 名称容易在浏览文件时被漏填；为空时用所选 zip 文件名兜底，不覆盖用户输入。
  const applyDefaultName = (fileName: string) => {
    if (!name.trim()) setName(fileName.replace(/\.zip$/i, ""));
  };
  const parentOf = (path: string) => {
    const trimmed = path.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    return index <= 0 ? "/" : trimmed.slice(0, index);
  };
  const childOf = (entryName: string) => `${ftpPath.replace(/\/+$/, "")}/${entryName}`;
  const pickFtpDir = (path: string, entryName: string) => {
    setFtpSelected(path);
    applyDefaultName(entryName);
  };

  return <Modal
      className="import-center-modal"
      title="导入数据"
      open
      onCancel={onClose}
      width={940}
      footer={source === "video" ? null : [
        <AntdButton key="cancel" onClick={onClose}>取消</AntdButton>,
        <AntdButton key="import" type="primary" disabled={busy || !canImport} onClick={importArchive}>开始导入</AntdButton>,
      ]}
    >
    <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
      选择数据来源。视频会先预检，确认后才在服务端后台抽帧创建数据集。
    </Typography.Paragraph>
    <Tabs
      tabPlacement="start"
      activeKey={source}
      onChange={(key) => chooseSource(key as ImportSource)}
      className="import-center-tabs"
      aria-label="导入来源"
      items={SOURCES.map((item) => ({
        key: item.id,
        label: (
          <span className="import-source-tab">
            <span className="import-source-icon" aria-hidden>{item.icon}</span>
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
          </span>
        ),
        children: item.id === "video" ? (
          <div className="import-center-panel"><VideoImportContent onClose={onClose} onCompleted={onVideoCompleted} /></div>
        ) : (
          <div className="import-center-panel">
            <div className="import-center-step"><span>1</span><div><strong>{item.title}</strong><p>{item.detail}</p></div></div>
          <Form layout="vertical" className="import-center-form">
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="数据集名称" required>
                  <AntdInput value={name} placeholder="例如：road-signs" onChange={(event) => setName(event.target.value)} autoFocus />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="产出模型名（选填）">
                  <AntdInput value={modelName} placeholder="例如：blade-detector" onChange={(event) => setModelName(event.target.value)} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label="任务类型">
                  <AntdSelect value={taskType} onChange={(value) => setTaskType(value)} options={[
                    { value: "detect", label: "目标检测（Bounding Box）" },
                    { value: "segment", label: "实例分割（Polygon / SAM）" },
                    { value: "obb", label: "旋转框（OBB）" },
                    { value: "classify", label: "图像分类" },
                    ...(source === "yolo" ? [{ value: "pose", label: "关键点检测（Pose）" }] : []),
                  ]} />
                </Form.Item>
              </Col>
            </Row>
            {taskType === "pose" && source === "coco" && <Typography.Text type="danger" style={{ fontSize: 12 }}>COCO 格式暂不支持 pose，请选择 YOLO 来源。</Typography.Text>}
          </Form>
          <Segmented block value={origin} onChange={(value) => setOrigin(value as "local" | "ftp")} aria-label="文件来源" options={[{ value: "local", label: "本机文件" }, { value: "ftp", label: "FTP 选择" }]} />
          {origin === "local" ? <>
            <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; setArchive(file); if (file) applyDefaultName(file.name); event.currentTarget.value = ""; }} />
            <button type="button" className={dragging ? "exchange-dropzone dragging" : "exchange-dropzone"} onClick={() => inputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); setArchive(event.dataTransfer.files[0]); if (event.dataTransfer.files[0]) applyDefaultName(event.dataTransfer.files[0].name); }}><span className="exchange-dropzone-icon">⇧</span><strong>{archive?.name ?? `拖放或选择 ${source.toUpperCase()} ZIP 文件`}</strong><small>{archive ? `${Math.ceil(archive.size / 1024)} KB · 已准备导入` : source === "yolo" ? "ZIP 内应包含 data.yaml、images 和 labels" : "ZIP 内应包含 annotations.json/instances.json 与 images"}</small></button>
          </> : (
            <div className="import-ftp-picker">
              <Flex gap={8} align="center" wrap="wrap">
                <AntdButton disabled={ftpLoading || ftpPath === "/"} onClick={() => browseFtp(parentOf(ftpPath))}>↑ 上级</AntdButton>
                <AntdSpace.Compact>
                  <AntdInput value={ftpPath} aria-label="FTP 路径" onChange={(event) => setFtpPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") browseFtp(ftpPath); }} style={{ width: 240 }} />
                  <AntdButton disabled={ftpLoading} onClick={() => browseFtp(ftpPath)}>浏览</AntdButton>
                </AntdSpace.Compact>
                <Segmented value={ftpKind} onChange={(value) => { setFtpKind(value as "zip" | "dir"); setFtpSelected(""); }} aria-label="FTP 来源类型" options={[{ value: "zip", label: "ZIP 文件" }, { value: "dir", label: "YOLO 目录" }]} />
                {ftpKind === "dir" && (
                  <AntdButton disabled={ftpLoading || ftpPath === "/"} title="把当前浏览到的目录作为导入目标" onClick={() => pickFtpDir(ftpPath, ftpPath.replace(/\/+$/, "").split("/").pop() || "ftp-dataset")}>选当前目录</AntdButton>
                )}
              </Flex>
              <div className="import-ftp-list">
                {ftpLoading && <p className="muted">正在读取目录…</p>}
                {ftpError && <p className="annotation-form-error">{ftpError}（请先在「FTP 管理」页配置连接）</p>}
                {!ftpLoading && !ftpError && ftpEntries?.map((entry) => entry.is_dir
                  ? (ftpKind === "dir"
                    ? <div key={entry.name} className={`import-ftp-row dir selectable${ftpSelected === childOf(entry.name) ? " selected" : ""}`}>
                        <button type="button" className="import-ftp-pick" aria-pressed={ftpSelected === childOf(entry.name)} aria-label={`选择目录 ${entry.name}`} title="选择此目录作为导入目标" onClick={() => pickFtpDir(childOf(entry.name), entry.name)}>{ftpSelected === childOf(entry.name) ? "✓" : "＋"}</button>
                        <button type="button" className="import-ftp-browse" onClick={() => browseFtp(childOf(entry.name))}><span>📁</span><strong>{entry.name}</strong><small>目录 · 点击进入</small></button>
                      </div>
                    : <button key={entry.name} type="button" className="import-ftp-row dir" onClick={() => browseFtp(childOf(entry.name))}><span>📁</span><strong>{entry.name}</strong><small>目录</small></button>)
                  : <button key={entry.name} type="button" disabled={ftpKind === "dir" || !entry.name.toLowerCase().endsWith(".zip")} className={`import-ftp-row file${ftpSelected === childOf(entry.name) ? " selected" : ""}`} onClick={() => { setFtpSelected(childOf(entry.name)); applyDefaultName(entry.name); }}><span>🗜</span><strong>{entry.name}</strong><small>{entry.size != null ? `${Math.ceil(entry.size / 1024)} KB` : ""}</small></button>)}
                {!ftpLoading && !ftpError && ftpEntries && ftpKind === "zip" && !ftpEntries.some((entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(".zip")) && <p className="muted">当前目录没有 .zip 文件。</p>}
                {!ftpLoading && !ftpError && ftpEntries && ftpKind === "dir" && !ftpEntries.some((entry) => entry.is_dir) && <p className="muted">当前目录没有子目录；可点上方「选当前目录」选择当前路径。</p>}
              </div>
              {ftpSelected && <p className="import-ftp-selected">已选择:{ftpSelected}{ftpKind === "dir" ? "（YOLO 目录，将递归采集）" : ""}</p>}
            </div>
          )}
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              {origin === "ftp" ? (ftpKind === "dir" ? "后端会递归采集所选 YOLO 目录（data.yaml、images、labels）并打包导入。" : "后端会从 FTP 下载所选 ZIP 并导入服务端受管目录。") : "文件仅导入到服务端受管数据目录。"}
            </Typography.Paragraph>
          </div>
        ),
      }))}
    />
  </Modal>;
}
