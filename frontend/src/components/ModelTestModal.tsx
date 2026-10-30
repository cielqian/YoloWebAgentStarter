import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button as AntdButton, Modal, Slider, Space, Typography } from "antd";
import { Circle, Image as KonvaImage, Layer, Line, Rect, Stage, Text } from "react-konva";
import { api } from "../api/client";
import type { InferenceResult, ModelVersion } from "../types";

export function ModelTestModal({ model, onClose }: { model: ModelVersion; onClose: () => void }) {
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState("");
  const [image, setImage] = useState<HTMLImageElement>();
  const [result, setResult] = useState<InferenceResult>();
  const [confidence, setConfidence] = useState(0.25);
  const [iou, setIou] = useState(0.45);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 620, height: 420 });

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { if (!url) return; const next = new Image(); next.onload = () => { const max = ref.current?.clientWidth ?? 620; const ratio = Math.min(max / next.width, 460 / next.height, 1); setImage(next); setSize({ width: Math.round(next.width * ratio), height: Math.round(next.height * ratio) }); }; next.src = url; }, [url]);
  const visible = useMemo(() => result?.detections.filter((item) => item.confidence >= confidence) ?? [], [result, confidence]);
  const scale = image ? size.width / image.width : 1;
  const select = (next?: File) => { if (!next) return; if (url) URL.revokeObjectURL(url); setFile(next); setUrl(URL.createObjectURL(next)); setResult(undefined); setError(""); };
  const run = async () => { if (!file) return; setBusy(true); setError(""); try { setResult(await api.testModel(model.id, file, confidence, iou)); } catch (reason) { setError(reason instanceof Error ? reason.message : "推理失败"); } finally { setBusy(false); } };
  return (
    <Modal title={`测试 ${model.name}`} open onCancel={onClose} width={920} footer={null}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        上传一张图片，在本机运行受管模型；结果不会保存到数据集。
      </Typography.Paragraph>
      <div className="model-test-body">
        <aside className="model-test-controls">
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <button type="button" className="import-file-picker" onClick={() => document.getElementById("model-test-file-input")?.click()}>
              <input id="model-test-file-input" type="file" accept="image/*" hidden onChange={(event) => { select(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              <span>⇧</span>
              <strong>{file?.name ?? "选择测试图片"}</strong>
              <small>图片仅用于本次本地推理</small>
            </button>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>置信度 {confidence.toFixed(2)}</Typography.Text>
              <Slider min={0.01} max={0.99} step={0.05} value={confidence} onChange={setConfidence} />
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>IoU {iou.toFixed(2)}</Typography.Text>
              <Slider min={0} max={0.99} step={0.05} value={iou} onChange={setIou} />
            </div>
            <AntdButton type="primary" block disabled={!file || busy} onClick={() => void run()}>{busy ? "正在推理…" : "运行本地测试"}</AntdButton>
            {error && <Alert type="error" showIcon title={error} />}
            {result && (
              <div className="test-results">
                <strong>{visible.length} 个结果 · {result.inference_time_ms.toFixed(1)} ms</strong>
                {visible.map((item, index) => <span key={`${item.class_index}-${index}`}>{item.class_name} <b>{(item.confidence * 100).toFixed(1)}%</b></span>)}
              </div>
            )}
          </Space>
        </aside>
        <div className="test-canvas" ref={ref}>{image ? <Stage width={size.width} height={size.height}><Layer><KonvaImage image={image} width={size.width} height={size.height} />{visible.map((item, index) => { const polygon = item.polygon?.flatMap((point) => [point[0] * scale, point[1] * scale]); const obb = item.obb_points?.flatMap((point) => [point[0] * scale, point[1] * scale]); const keypoints = item.keypoints ?? null; const x = (polygon?.[0] ?? obb?.[0] ?? item.x * scale); const y = (polygon?.[1] ?? obb?.[1] ?? item.y * scale); return <>{polygon ? <Line key={`shape-${index}`} points={polygon} closed stroke="#22c55e" fill="rgba(34,197,94,.22)" strokeWidth={2} /> : obb ? <Line key={`shape-${index}`} points={obb} closed stroke="#f59e0b" fill="rgba(245,158,11,.18)" strokeWidth={2} /> : item.width > 0 ? <Rect key={`shape-${index}`} x={item.x * scale} y={item.y * scale} width={item.width * scale} height={item.height * scale} stroke="#22c55e" strokeWidth={2} /> : null}{keypoints?.map((keypoint, keypointIndex) => keypoint[2] > 0 ? <Circle key={`kpt-${index}-${keypointIndex}`} x={keypoint[0] * scale} y={keypoint[1] * scale} radius={3.5} fill="#f43f5e" stroke="#fff" strokeWidth={1} /> : null)}<Text key={`label-${index}`} x={x} y={Math.max(0, y - 18)} text={`${item.class_name} ${(item.confidence * 100).toFixed(0)}%`} fill="#fff" fontSize={12} padding={4} background="#22c55e" /></>; })}</Layer></Stage> : <div className="empty-state"><strong>选择一张图片开始测试</strong><span>检测、分割、OBB、关键点与分类模型均使用上游同款测试工作流。</span></div>}</div>
      </div>
    </Modal>
  );
}
