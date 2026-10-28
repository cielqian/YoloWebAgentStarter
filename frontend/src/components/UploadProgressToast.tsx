import type { UploadProgress } from "../api/client";

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 全局上传进度条：大文件上传期间固定悬浮展示，上传完由父级卸载。 */
export function UploadProgressToast({ label, progress }: { label: string; progress: UploadProgress }) {
  const percent = Math.round(progress.percent);
  const done = percent >= 100;
  return (
    <div className="upload-progress-toast" role="status" aria-live="polite" aria-label="上传进度">
      <div className="upload-progress-toast-head">
        <strong>{done ? `${label} 上传完成，服务器处理中…` : `正在上传 ${label}`}</strong>
        <span>{progress.total > 0 ? `${formatSize(progress.loaded)} / ${formatSize(progress.total)} · ` : ""}{percent}%</span>
      </div>
      <div className="progress-track"><i style={{ width: `${Math.min(100, Math.max(2, progress.percent))}%` }} /></div>
    </div>
  );
}
