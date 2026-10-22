import { useEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Circle, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type { Annotation, BBox, ImageItem, OBB, PoseConfig, SamCapabilities, TaskType } from "../types";
import { clamp, clampBBoxToImage, clampOBBToImage, MIN_SHAPE_SIZE, nearestEdgeOnPolygon, normalizeAngle, normalizeBBox, simplifyPolygon, toOriginalPoint } from "../utils/geometry";

export type AnnotationDraft = {
  id?: string;
  class_id: string;
  type: "bbox" | "polygon" | "obb" | "classify" | "pose";
  bbox?: BBox;
  polygon?: [number, number][];
  obb?: OBB;
  /** pose 关键点 [x, y, v]，绝对像素；长度与数据集 kpt_count 一致。 */
  keypoints?: [number, number, number][];
  source: "manual" | "imported" | "sam" | "auto";
};

interface Props {
  image: ImageItem;
  annotations: Annotation[];
  activeClassId: string;
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  taskType: TaskType;
  onChange: (annotations: AnnotationDraft[]) => void;
  onSamBox?: (box: BBox) => Promise<void>;
  onSamPoints?: (points: [number, number][]) => Promise<void>;
  samBusy?: boolean;
  samCapabilities?: SamCapabilities;
  /** pose 数据集的骨架配置：关键点数量与可视化连线。 */
  poseConfig?: PoseConfig | null;
  /** 仅影响画布渲染（查看辅助），不会从草稿数据中移除。 */
  hiddenAnnotationIds?: Set<string>;
  /** 只读模式（激活历史版本）：禁止绘制与编辑，仅查看；平移缩放仍可用。 */
  readOnly?: boolean;
}

const MAX_WIDTH = 900;
const MAX_HEIGHT = 620;
const ZOOM_MIN = 1;
const ZOOM_MAX = 20;
// 靠近已放置的第一个顶点该屏幕距离内点击即闭合多边形（图层坐标阈值随缩放换算）
const SNAP_CLOSE_RADIUS_PX = 12;

type PanState = { origin: [number, number]; start: { x: number; y: number } };

type DrawingTool = "select" | "bbox" | "polygon" | "circle" | "rect" | "obb" | "pose" | "sam" | "sam_point";

const taskTool = (taskType: TaskType): DrawingTool => ({ detect: "bbox", segment: "polygon", obb: "obb", classify: "bbox", pose: "pose" } satisfies Record<TaskType, DrawingTool>)[taskType];

function panModifierActive(event: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return Boolean(event.ctrlKey || event.metaKey);
}

export function AnnotationCanvas({ image, annotations, activeClassId, selectedAnnotationId, onSelectAnnotation, taskType, onChange, onSamBox, onSamPoints, samBusy = false, samCapabilities, poseConfig, hiddenAnnotationIds, readOnly = false }: Props) {
  const [imageElement, setImageElement] = useState<HTMLImageElement>();
  const [tool, setTool] = useState<DrawingTool>(() => taskTool(taskType));
  const [dragStart, setDragStart] = useState<[number, number]>();
  const [dragEnd, setDragEnd] = useState<[number, number]>();
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [hoverPoint, setHoverPoint] = useState<[number, number]>();
  const [simplifyTolerance, setSimplifyTolerance] = useState(2);
  const [angle, setAngle] = useState(0);
  const [selectedObbId, setSelectedObbId] = useState<string>();
  const [selectedBboxId, setSelectedBboxId] = useState<string>();
  const [selectedPolygonId, setSelectedPolygonId] = useState<string>();
  const [displaySize, setDisplaySize] = useState({ width: MAX_WIDTH, height: MAX_HEIGHT });
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState<PanState>();
  const [panModifier, setPanModifier] = useState(false);
  const [shapeMenu, setShapeMenu] = useState<{ x: number; y: number } | null>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const obbRefs = useRef<Record<string, Konva.Rect | null>>({});
  const bboxRefs = useRef<Record<string, Konva.Rect | null>>({});

  useEffect(() => {
    const element = new window.Image();
    element.onload = () => {
      setImageElement(element);
    };
    element.src = image.file_url.startsWith("http") ? image.file_url : `${(import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000").replace(/\/$/, "")}${image.file_url}`;
  }, [image]);

  // 画布按 stage-wrap 实际可用区域等比缩放，随窗口尺寸自适应（不超过原图尺寸）。
  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap || !imageElement) return;
    const fit = () => {
      const box = wrap.getBoundingClientRect();
      if (box.width < 10 || box.height < 10) return;
      const ratio = Math.min(box.width / image.width, box.height / image.height, 1);
      setDisplaySize({ width: Math.max(1, Math.round(image.width * ratio)), height: Math.max(1, Math.round(image.height * ratio)) });
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [image, imageElement]);

  useEffect(() => {
    setTool(taskTool(taskType));
    setPolygonPoints([]);
    setDragStart(undefined);
    setDragEnd(undefined);
    setSelectedObbId(undefined);
    setSelectedBboxId(undefined);
    setSelectedPolygonId(undefined);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanning(undefined);
  }, [taskType, image.id]);

  useEffect(() => {
    if (tool === "sam_point" && !samCapabilities?.point_prompt_available) setTool("polygon");
  }, [samCapabilities?.point_prompt_available, tool]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (readOnly || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const lower = event.key.toLowerCase();
      if (taskType === "segment" && !samBusy) {
        if (lower === "p" && canAnnotate) { setTool("polygon"); setPolygonPoints([]); setDragStart(undefined); }
        else if (lower === "r" && canAnnotate) { setTool("rect"); setPolygonPoints([]); setDragStart(undefined); }
        else if (lower === "c" && canAnnotate) { setTool("circle"); setPolygonPoints([]); setDragStart(undefined); }
        else if (event.key === "Enter") { finishActiveShape(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.ctrlKey || event.metaKey) setPanModifier(true); };
    const up = (event: KeyboardEvent) => { if (!event.ctrlKey && !event.metaKey) setPanModifier(false); };
    const reset = () => setPanModifier(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const scale = useMemo(() => ({ x: displaySize.width / image.width, y: displaySize.height / image.height }), [displaySize, image]);
  const effectiveSelectedAnnotationId = selectedAnnotationId !== undefined ? selectedAnnotationId : selectedObbId ?? selectedBboxId ?? selectedPolygonId;
  const selectedObb = annotations.find((item) => item.id === effectiveSelectedAnnotationId && item.type === "obb");
  const selectedBbox = annotations.find((item) => item.id === effectiveSelectedAnnotationId && (item.type === "bbox" || item.type === "pose"));
  const selectedPolygon = annotations.find((item) => item.id === effectiveSelectedAnnotationId && item.type === "polygon" && item.polygon);
  // SAM 点选会一次生成多个互相重叠的实例；把选中多边形置顶，双击边线加点/拖顶点才不会被其它实例挡住。
  const orderedAnnotations = useMemo(() => {
    const visible = annotations.filter((item) => !hiddenAnnotationIds?.has(item.id));
    const selectedId = selectedPolygon?.id;
    if (!selectedId) return visible;
    return [...visible.filter((item) => item.id !== selectedId), ...visible.filter((item) => item.id === selectedId)];
  }, [annotations, hiddenAnnotationIds, selectedPolygon?.id]);

  useEffect(() => {
    const node = selectedObb ? obbRefs.current[selectedObb.id] : selectedBbox ? bboxRefs.current[selectedBbox.id] : null;
    transformerRef.current?.nodes(!readOnly && node ? [node] : []);
    transformerRef.current?.getLayer()?.batchDraw();
  }, [annotations, selectedBbox, selectedObb, hiddenAnnotationIds]);

  useEffect(() => {
    if (!dragStart) return;
    const cancelDrawing = () => {
      setDragStart(undefined);
      setDragEnd(undefined);
    };
    window.addEventListener("mouseup", cancelDrawing);
    return () => {
      window.removeEventListener("mouseup", cancelDrawing);
    };
  }, [dragStart]);

  useEffect(() => {
    if (!panning) return;
    const stopPanning = () => setPanning(undefined);
    window.addEventListener("mouseup", stopPanning);
    return () => {
      window.removeEventListener("mouseup", stopPanning);
    };
  }, [panning]);

  const toOriginal = (point: [number, number]) => toOriginalPoint(point, displaySize.width, displaySize.height, image.width, image.height);
  const stagePointer = (event: { target: { getStage: () => { getPointerPosition: () => { x: number; y: number } | null } | null } }): [number, number] | undefined => {
    const stage = event.target.getStage();
    const position = stage?.getPointerPosition();
    if (!position) return undefined;
    return [position.x, position.y];
  };
  // 缩放/平移作用在 Layer 变换上，绘制坐标需从舞台坐标换回图层（贴合）坐标。
  const pointer = (event: Parameters<typeof stagePointer>[0]): [number, number] | undefined => {
    const point = stagePointer(event);
    if (!point) return undefined;
    return [clamp((point[0] - pan.x) / zoom, 0, displaySize.width), clamp((point[1] - pan.y) / zoom, 0, displaySize.height)];
  };
  const handleWheel = (event: KonvaEventObject<WheelEvent>) => {
    if (!(event.evt.ctrlKey || event.evt.metaKey)) return;
    event.evt.preventDefault();
    const point = stagePointer(event);
    if (!point) return;
    const factor = clamp(Math.exp(-event.evt.deltaY * 0.002), 0.8, 1.25);
    const nextZoom = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (nextZoom === zoom) return;
    if (nextZoom <= ZOOM_MIN) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    // 保持光标下的图像点不动：pan' = pointer - (pointer - pan) / zoom * nextZoom
    setPan({
      x: point[0] - (point[0] - pan.x) * (nextZoom / zoom),
      y: point[1] - (point[1] - pan.y) * (nextZoom / zoom),
    });
    setZoom(nextZoom);
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const toStageObb = (obb: OBB): OBB => ({ ...obb, cx: obb.cx * scale.x, cy: obb.cy * scale.y, width: obb.width * scale.x, height: obb.height * scale.y });
  const toImageObb = (obb: OBB): OBB => clampOBBToImage(
    { ...obb, cx: obb.cx / scale.x, cy: obb.cy / scale.y, width: obb.width / scale.x, height: obb.height / scale.y, angle: normalizeAngle(obb.angle) },
    image.width,
    image.height,
  );

  const replaceBbox = (id: string, stageBox: BBox) => {
    const updated = clampBBoxToImage(
      { x: stageBox.x / scale.x, y: stageBox.y / scale.y, width: stageBox.width / scale.x, height: stageBox.height / scale.y },
      image.width,
      image.height,
    );
    onChange(annotations.map((item) => item.id === id && (item.type === "bbox" || item.type === "pose") ? { ...toDraft(item), bbox: updated } : toDraft(item)));
  };

  const kptCount = poseConfig?.kpt_count ?? 0;
  const movePoseKeypoint = (id: string, index: number, stagePoint: [number, number]) => {
    const point = toOriginal(stagePoint);
    const clamped: [number, number, number] = [clamp(point[0], 0, image.width), clamp(point[1], 0, image.height), 2];
    onChange(annotations.map((item) => {
      if (item.id !== id || !item.keypoints) return toDraft(item);
      const keypoints: [number, number, number][] = item.keypoints.map((keypoint, i) => (i === index ? clamped : keypoint));
      return { ...toDraft(item), keypoints };
    }));
  };
  const togglePoseKeypoint = (id: string, index: number) => {
    onChange(annotations.map((item) => {
      if (item.id !== id || !item.keypoints) return toDraft(item);
      const keypoints: [number, number, number][] = item.keypoints.map((keypoint, i): [number, number, number] =>
        i === index ? [keypoint[0], keypoint[1], keypoint[2] > 0 ? 0 : 2] : keypoint,
      );
      return { ...toDraft(item), keypoints };
    }));
  };

  const replaceObb = (id: string, stageObb: OBB) => {
    const updated = toImageObb(stageObb);
    onChange(annotations.map((item) => item.id === id && item.type === "obb" ? { ...toDraft(item), obb: updated } : toDraft(item)));
  };
  const movePolygonVertex = (id: string, index: number, stagePoint: [number, number]) => {
    const point = toOriginal(stagePoint);
    const clamped: [number, number] = [clamp(point[0], 0, image.width), clamp(point[1], 0, image.height)];
    onChange(annotations.map((item) => {
      if (item.id !== id || !item.polygon) return toDraft(item);
      const polygon = item.polygon.map((vertex, i) => i === index ? clamped : vertex);
      return { ...toDraft(item), polygon };
    }));
  };
  const deletePolygonVertex = (id: string, index: number) => {
    const target = annotations.find((item) => item.id === id);
    if (!target?.polygon || target.polygon.length <= 3) return;
    onChange(annotations.map((item) => {
      if (item.id !== id || !item.polygon) return toDraft(item);
      return { ...toDraft(item), polygon: item.polygon.filter((_, i) => i !== index) };
    }));
  };
  const insertPolygonVertex = (id: string, layerPoint: [number, number]) => {
    const target = annotations.find((item) => item.id === id);
    if (!target?.polygon) return;
    const displayPoints = target.polygon.map(([x, y]) => [x * scale.x, y * scale.y] as [number, number]);
    const hit = nearestEdgeOnPolygon(displayPoints, layerPoint);
    if (!hit || hit.distance > 10 / zoom) return;
    const point = toOriginal(hit.point);
    const vertex: [number, number] = [clamp(point[0], 0, image.width), clamp(point[1], 0, image.height)];
    const polygon = [...target.polygon.slice(0, hit.index + 1), vertex, ...target.polygon.slice(hit.index + 1)];
    onChange(annotations.map((item) => (item.id === id ? { ...toDraft(item), polygon } : toDraft(item))));
  };
  const simplifySelectedPolygon = () => {
    if (!selectedPolygon?.polygon) return;
    const simplified = simplifyPolygon(selectedPolygon.polygon, simplifyTolerance);
    if (simplified.length === selectedPolygon.polygon.length) return;
    onChange(annotations.map((item) => (item.id === selectedPolygon.id ? { ...toDraft(item), polygon: simplified } : toDraft(item))));
  };
  const removeSelectedObb = () => {
    if (!selectedObb?.id) return;
    onChange(annotations.filter((item) => item.id !== selectedObb.id).map(toDraft));
    setSelectedObbId(undefined);
    onSelectAnnotation?.(null);
  };
  const finishPolygon = () => {
    if (polygonPoints.length < 3) return;
    onChange([...annotations.map(toDraft), { id: newDraftId(), class_id: activeClassId, type: "polygon", polygon: polygonPoints.map(toOriginal), source: "manual" }]);
    setPolygonPoints([]);
    setHoverPoint(undefined);
  };

  const finishActiveShape = () => finishPolygon();

  const clampPoint = (point: [number, number]): [number, number] => [
    clamp(point[0], 0, image.width),
    clamp(point[1], 0, image.height),
  ];
  const distanceToFirst = (point: [number, number]) => polygonPoints.length >= 3 ? Math.hypot(point[0] - polygonPoints[0][0], point[1] - polygonPoints[0][1]) : Infinity;
  const snapActive = tool === "polygon" && hoverPoint !== undefined && distanceToFirst(hoverPoint) <= SNAP_CLOSE_RADIUS_PX / zoom;
  const clearAllDrafts = () => {
    if (!annotations.length || !window.confirm("清空当前图片的全部草稿？此操作只会在点击“保存标注”后写入删除结果。")) return;
    onChange([]);
    setPolygonPoints([]);
    setDragStart(undefined);
    setDragEnd(undefined);
    setSelectedBboxId(undefined);
    setSelectedObbId(undefined);
    onSelectAnnotation?.(null);
  };
  const samConfigured = samCapabilities?.model_configured ?? false;
  const pointPromptAvailable = samCapabilities?.point_prompt_available ?? false;
  const canAnnotate = Boolean(activeClassId) && !readOnly;
  const selectedAngle = selectedObb?.obb?.angle ?? angle;
  const draftObb = dragStart && dragEnd && tool === "obb" ? normalizeBBox(dragStart, dragEnd) : undefined;
  const [samElapsed, setSamElapsed] = useState(0);
  useEffect(() => {
    if (!samBusy) {
      setSamElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setSamElapsed(0);
    const timer = window.setInterval(() => setSamElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [samBusy]);
  const guide = readOnly
    ? "只读模式：仅可查看，无法绘制或编辑。"
    : samBusy
      ? `SAM 推理中，已用 ${samElapsed} 秒；远程 SAM3 单次推理一般需要 20~60 秒，完成后会自动生成多边形建议。`
      : !canAnnotate
        ? "请先在右侧新增一个类别，再开始绘制。"
        : taskType === "pose"
          ? selectedBbox
            ? "已选中姿态：拖动框体移动、手柄缩放；拖动圆点定位关键点（拖动即标记为可见），双击圆点切换 已标注/未标注。"
            : `拖拽创建姿态框；关键点会先均匀摆在框内，逐一拖到目标位置。数据集骨架：${kptCount} 个关键点。`
        : taskType === "obb"
          ? selectedObb ? "已选中 OBB：拖动可移动，四角手柄可缩放，顶部圆形手柄可旋转。" : "拖拽创建 OBB；点击既有框即可选择、旋转、缩放或删除。"
          : taskType === "detect" && selectedBbox
            ? "已选中框：拖动可移动，四角手柄可调整大小；BBox 不支持旋转。"
            : selectedPolygon
              ? "已选中多边形：拖动顶点调整形状，双击边线添加顶点，双击顶点删除（至少保留 3 个点）；SAM 生成的密集轮廓可先“简化顶点”再微调。"
              : tool === "select"
                ? "已退出绘制：点击既有标注可选中并编辑；点选上方工具继续绘制。"
                : tool === "sam"
                  ? samConfigured ? "拖拽一个提示框，SAM 会返回一个或多个可确认的多边形建议。" : "未配置 SAM：框选只会生成可审阅的矩形建议，不会运行模型推理。"
                  : tool === "sam_point"
                    ? "点击图片任意位置触发推理，SAM 会把图中该类别的全部实例生成为多边形建议；只标注单个对象请用 SAM 框选。"
                    : taskType === "segment" && !samConfigured ? "SAM 未配置；可使用 Polygon，或使用仅供审阅的框形建议。" : "";
  const polygonTip = tool === "polygon" && polygonPoints.length > 0
    ? "已放置的顶点可直接拖动调整、双击删除；靠近第一个点点击可自动闭合多边形。"
    : "";

  return (
    <section className="canvas-card">
      <div className="canvas-toolbar">
        <div className="tool-group">
          {taskType === "detect" && <button className={tool === "bbox" ? "button active" : "button"} disabled={!canAnnotate} onClick={() => { setTool("bbox"); setPolygonPoints([]); }}>BBox</button>}
          {taskType === "pose" && <button className={tool === "pose" ? "button active" : "button"} disabled={!canAnnotate} onClick={() => { setTool("pose"); setPolygonPoints([]); }}>Pose</button>}
          {taskType === "segment" && <><select aria-label="绘制形状" className={tool === "polygon" || tool === "rect" || tool === "circle" ? "shape-tool-select active" : "shape-tool-select"} disabled={!canAnnotate} value={tool === "rect" ? "rect" : tool === "circle" ? "circle" : "polygon"} onChange={(event) => { setTool(event.target.value as DrawingTool); setPolygonPoints([]); setDragStart(undefined); }}>
              <option value="polygon">多边形（P）· 逐点</option>
              <option value="rect">矩形（R）· 拖拽</option>
              <option value="circle">圆形（C）· 拖拽</option>
            </select><button className={`button${tool === "sam" ? " active" : ""}${samBusy ? " sam-busy" : ""}`} disabled={!canAnnotate || samBusy || !samCapabilities?.box_prompt_available} onClick={() => { setTool("sam"); setPolygonPoints([]); }}>{samBusy ? `推理中 ${samElapsed}s…` : samConfigured ? "SAM 框选" : "框形建议"}</button><button className={`button${tool === "sam_point" ? " active" : ""}${samBusy ? " sam-busy" : ""}`} disabled={!canAnnotate || samBusy || !pointPromptAvailable} title={pointPromptAvailable ? undefined : "配置 YWA_SAM_MODEL 后可用"} onClick={() => { setTool("sam_point"); setPolygonPoints([]); }}>{samBusy ? `推理中 ${samElapsed}s…` : pointPromptAvailable ? "SAM 点选" : "SAM 点选（需配置）"}</button></>}
          {taskType === "obb" && <><button className={tool === "obb" ? "button active" : "button"} disabled={!canAnnotate} onClick={() => { setTool("obb"); setPolygonPoints([]); }}>OBB</button><label className="angle-input">角度<input aria-label="OBB angle" type="number" value={selectedAngle} disabled={readOnly} onChange={(event) => { const nextAngle = Number(event.target.value); if (!Number.isFinite(nextAngle)) return; if (selectedObb?.obb) replaceObb(selectedObb.id, { ...toStageObb(selectedObb.obb), angle: nextAngle }); else setAngle(nextAngle); }} /></label>{selectedObb && <button className="button danger" disabled={readOnly} onClick={removeSelectedObb}>删除所选 OBB</button>}</>}
          {(tool === "polygon" || tool === "rect" || tool === "circle") && <button className="button primary" disabled={!canAnnotate} onClick={finishActiveShape} title="快捷键 Enter">{tool === "rect" ? "完成矩形" : tool === "circle" ? "完成圆形" : "完成多边形"}</button>}
          {selectedPolygon && <><select aria-label="简化精度" className="simplify-tolerance" value={simplifyTolerance} onChange={(event) => setSimplifyTolerance(Number(event.target.value))}><option value={1}>1px</option><option value={2}>2px</option><option value={4}>4px</option><option value={8}>8px</option><option value={16}>16px</option></select><button className="button" disabled={readOnly} onClick={simplifySelectedPolygon}>简化顶点</button></>}
          <button className="button danger" disabled={!annotations.length || readOnly} onClick={clearAllDrafts}>清空全部草稿</button>
        </div>
      </div>
      <p className="hint interaction-summary" aria-label="交互说明">
        <span><b>Ctrl/⌘ + 滚轮</b>缩放</span>
        <span><b>Ctrl/⌘ + 拖动</b>平移</span>
        <span><b>← / →</b>切换图片（→ 保存并下一张）</span>
        <span><b>⌘/Ctrl + S</b>保存标注</span>
        <span><b>Esc</b>取消选中 / 退出专注</span>
        <span><b>D</b>下一张</span>
        <span><b>A</b>上一张</span>
        {taskType === "segment" && <span><b>P / R / C</b>多边形 / 矩形 / 圆形</span>}
      </p>
      <div className="stage-wrap" ref={stageWrapRef}>
        {(polygonTip || guide) && <div className="canvas-floating-tip" role="status">{polygonTip || guide}</div>}
        {shapeMenu && (
          <div className="canvas-context-menu" style={{ left: shapeMenu.x, top: shapeMenu.y }} onMouseLeave={() => setShapeMenu(null)}>
            <button type="button" onClick={() => { setTool("polygon"); setPolygonPoints([]); setShapeMenu(null); }}>多边形（P）</button>
            <button type="button" onClick={() => { setTool("rect"); setPolygonPoints([]); setShapeMenu(null); }}>矩形（R）</button>
            <button type="button" onClick={() => { setTool("circle"); setPolygonPoints([]); setShapeMenu(null); }}>圆形（C）</button>
          </div>
        )}
        {imageElement ? (
          <Stage
            width={displaySize.width}
            height={displaySize.height}
            style={{ cursor: panning ? "grabbing" : snapActive ? "pointer" : undefined }}
            onContextMenu={(event) => {
              if (taskType !== "segment" || readOnly || !activeClassId) return;
              event.evt.preventDefault();
              const stage = event.target.getStage();
              const position = stage?.container().getBoundingClientRect();
              if (position) setShapeMenu({ x: event.evt.clientX - position.left, y: event.evt.clientY - position.top });
            }}
            onWheel={handleWheel}
            onMouseDown={(event) => {
              if (event.evt.ctrlKey || event.evt.metaKey) {
                event.evt.preventDefault();
                const point = stagePointer(event);
                if (!point) return;
                setPanning({ origin: point, start: pan });
                setDragStart(undefined);
                setDragEnd(undefined);
                return;
              }
              if (readOnly || tool === "select" || !activeClassId) return;
              const point = pointer(event);
              if (!point) return;
              if (tool !== "polygon" && tool !== "rect" && tool !== "circle" && !["Stage", "Layer"].includes(event.target.getClassName())) return;
              if (tool === "sam_point" && onSamPoints) {
                void onSamPoints([toOriginal(point)]);
                setTool("select");
                return;
              }
              if (tool !== "polygon") setDragStart(point);
              else {
                if (distanceToFirst(point) <= SNAP_CLOSE_RADIUS_PX / zoom) {
                  finishPolygon();
                  return;
                }
                setPolygonPoints((current) => [...current, point]);
              }
            }}
            onMouseMove={(event) => {
              if (panning) {
                const point = stagePointer(event);
                if (!point) return;
                setPan({
                  x: panning.start.x + (point[0] - panning.origin[0]),
                  y: panning.start.y + (point[1] - panning.origin[1]),
                });
                return;
              }
              if (tool === "polygon") {
                setHoverPoint(pointer(event));
                return;
              }
              if (tool === "sam_point" || !dragStart) return;
              const point = pointer(event);
              if (point) setDragEnd(point);
            }}
            onMouseUp={(event) => {
              if (panning) {
                setPanning(undefined);
                return;
              }
              if (!activeClassId || tool === "polygon" || tool === "sam_point" || !dragStart) return;
              const point = pointer(event);
              if (!point) {
                setDragStart(undefined);
                setDragEnd(undefined);
                return;
              }
              const displayBox = normalizeBBox(dragStart, point);
              const box = { x: displayBox.x / scale.x, y: displayBox.y / scale.y, width: displayBox.width / scale.x, height: displayBox.height / scale.y };
              if (box.width >= MIN_SHAPE_SIZE && box.height >= MIN_SHAPE_SIZE) {
                if (tool === "rect") {
                  const pts: [number, number][] = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]];
                  const id = newDraftId();
                  onChange([...annotations.map(toDraft), { id, class_id: activeClassId, type: "polygon", polygon: pts.map(([x, y]) => clampPoint([x, y])), source: "manual" }]);
                  setSelectedPolygonId(id);
                }
                if (tool === "circle") {
                  const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
                  const r = Math.min(box.width, box.height) / 2;
                  const pts: [number, number][] = Array.from({ length: 48 }, (_, i) => {
                    const angle = (2 * Math.PI * i) / 48;
                    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as [number, number];
                  });
                  const id = newDraftId();
                  onChange([...annotations.map(toDraft), { id, class_id: activeClassId, type: "polygon", polygon: pts.map(([x, y]) => clampPoint([x, y])), source: "manual" }]);
                  setSelectedPolygonId(id);
                }
                if (tool === "bbox") onChange([...annotations.map(toDraft), { id: newDraftId(), class_id: activeClassId, type: "bbox", bbox: box, source: "manual" }]);
                if (tool === "pose" && poseConfig) {
                  const id = newDraftId();
                  onChange([...annotations.map(toDraft), { id, class_id: activeClassId, type: "pose", bbox: box, keypoints: initialKeypoints(box, poseConfig.kpt_count), source: "manual" }]);
                  setSelectedBboxId(id);
                }
                if (tool === "obb") {
                  const id = `draft-obb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                  onChange([...annotations.map(toDraft), { id, class_id: activeClassId, type: "obb", obb: clampOBBToImage({ cx: box.x + box.width / 2, cy: box.y + box.height / 2, width: box.width, height: box.height, angle }, image.width, image.height), source: "manual" }]);
                  setSelectedObbId(id);
                }
                if (tool === "sam" && onSamBox) {
                  void onSamBox(box);
                  setTool("select");
                }
              }
              setDragStart(undefined);
              setDragEnd(undefined);
            }}
            onMouseLeave={() => {
              setPanning(undefined);
              setHoverPoint(undefined);
              if (tool !== "polygon" && tool !== "sam_point") {
                setDragStart(undefined);
                setDragEnd(undefined);
              }
            }}
          >
            <Layer x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom}>
              <KonvaImage image={imageElement} width={displaySize.width} height={displaySize.height} listening={false} />
              {orderedAnnotations.map((annotation) => annotation.type === "obb" && annotation.obb ? <EditableObb key={annotation.id} annotation={annotation} stageObb={toStageObb(annotation.obb)} selected={annotation.id === effectiveSelectedAnnotationId} setNodeRef={(node) => { obbRefs.current[annotation.id] = node; }} onSelect={() => { setSelectedObbId(annotation.id); setSelectedBboxId(undefined); setSelectedPolygonId(undefined); onSelectAnnotation?.(annotation.id); }} panModifier={panModifier || readOnly} onChange={(updated) => replaceObb(annotation.id, updated)} /> : annotation.type === "pose" && annotation.bbox ? <PoseShape key={annotation.id} annotation={annotation} scale={scale} zoom={zoom} selected={annotation.id === effectiveSelectedAnnotationId} panModifier={panModifier || readOnly} skeleton={poseConfig?.skeleton ?? null} kptNames={poseConfig?.kpt_names ?? null} setNodeRef={(node) => { bboxRefs.current[annotation.id] = node; }} onSelect={() => { setSelectedBboxId(annotation.id); setSelectedObbId(undefined); setSelectedPolygonId(undefined); onSelectAnnotation?.(annotation.id); }} onChange={(updated) => replaceBbox(annotation.id, updated)} onMoveKeypoint={(index, point) => movePoseKeypoint(annotation.id, index, point)} onToggleKeypoint={(index) => togglePoseKeypoint(annotation.id, index)} /> : annotation.type === "bbox" && annotation.bbox ? <EditableBbox key={annotation.id} annotation={annotation} scale={scale} selected={annotation.id === effectiveSelectedAnnotationId} setNodeRef={(node) => { bboxRefs.current[annotation.id] = node; }} onSelect={() => { setSelectedBboxId(annotation.id); setSelectedObbId(undefined); setSelectedPolygonId(undefined); onSelectAnnotation?.(annotation.id); }} panModifier={panModifier || readOnly} onChange={(updated) => replaceBbox(annotation.id, updated)} /> : annotation.type === "polygon" && annotation.polygon && annotation.id === selectedPolygon?.id ? <EditablePolygon key={annotation.id} annotation={annotation} scale={scale} zoom={zoom} onSelect={() => { setSelectedPolygonId(annotation.id); setSelectedObbId(undefined); setSelectedBboxId(undefined); onSelectAnnotation?.(annotation.id); }} onMoveVertex={(index, point) => movePolygonVertex(annotation.id, index, point)} onDeleteVertex={(index) => deletePolygonVertex(annotation.id, index)} onInsertVertex={(point) => insertPolygonVertex(annotation.id, point)} panModifier={panModifier || readOnly} /> : <AnnotationShape key={annotation.id} annotation={annotation} scale={scale} onSelect={() => { setSelectedPolygonId(annotation.type === "polygon" ? annotation.id : undefined); onSelectAnnotation?.(annotation.id); }} />)}
              {dragStart && dragEnd && tool !== "obb" && <Rect {...displayBox(normalizeBBox(dragStart, dragEnd))} stroke="#f97316" strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} />}
              {draftObb && <Rect x={draftObb.x + draftObb.width / 2} y={draftObb.y + draftObb.height / 2} width={draftObb.width} height={draftObb.height} offsetX={draftObb.width / 2} offsetY={draftObb.height / 2} rotation={angle} stroke="#f97316" strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} />}
              {polygonPoints.length > 0 && (
                <>
                  <Line points={[...polygonPoints.flat(), ...(hoverPoint ? hoverPoint : [])]} stroke="rgba(249,115,22,.55)" strokeWidth={1.5} strokeScaleEnabled={false} closed={false} dash={[6, 4]} />
                  <Line
                    points={[...polygonPoints.flat(), ...(hoverPoint ? hoverPoint : []), polygonPoints[0][0], polygonPoints[0][1]]}
                    fill="rgba(249,115,22,.22)"
                    stroke="rgba(249,115,22,.35)"
                    strokeWidth={1}
                    strokeScaleEnabled={false}
                    closed
                  />
                </>
              )}
              {(tool === "polygon" || tool === "rect" || tool === "circle") && polygonPoints.map((point, index) => {
                const snapped = index === 0 && snapActive;
                return (
                  <Circle
                    key={index}
                    x={point[0]}
                    y={point[1]}
                    radius={snapped ? Math.max(7 / zoom, 3) : Math.max(3.5 / zoom, 1.5)}
                    fill={snapped ? "#22c55e" : "#fff"}
                    stroke={snapped ? "#22c55e" : "#f97316"}
                    strokeWidth={1.5}
                    strokeScaleEnabled={false}
                    draggable={!panModifier}
                    onMouseDown={(event) => {
                      if (panModifierActive(event.evt)) return;
                      event.cancelBubble = true;
                      if (index === 0 && polygonPoints.length >= 3) finishPolygon();
                    }}
                    onDragMove={(event) => setPolygonPoints((current) => current.map((vertex, i) => i === index ? [clamp(event.target.x(), 0, displaySize.width), clamp(event.target.y(), 0, displaySize.height)] as [number, number] : vertex))}
                    onDblClick={(event) => { event.cancelBubble = true; setPolygonPoints((current) => current.filter((_, i) => i !== index)); }}
                    onDblTap={(event) => { event.cancelBubble = true; setPolygonPoints((current) => current.filter((_, i) => i !== index)); }}
                  />
                );
              })}
            </Layer>
            <Layer>
              {/* 放在未缩放的覆盖层，缩放时手柄/边框保持屏幕尺寸；boundBoxFunc 阈值换算到舞台绝对坐标。 */}
              <Transformer ref={transformerRef} rotateEnabled={Boolean(selectedObb)} flipEnabled={false} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} rotateAnchorOffset={28} strokeScaleEnabled={false} boundBoxFunc={(previous, next) => next.width < MIN_SHAPE_SIZE * scale.x * zoom || next.height < MIN_SHAPE_SIZE * scale.y * zoom ? previous : next} />
            </Layer>
          </Stage>
        ) : <div className="loading">正在载入图片…</div>}
      </div>
      <div className="canvas-meta">
        <span>{image.width} × {image.height}px</span>
        <span>缩放 {Math.round(zoom * 100)}%</span>
        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && <button className="canvas-zoom-reset" onClick={resetView}>重置视图</button>}
        <span>{annotations.length} 个当前草稿{hiddenAnnotationIds?.size ? `（${annotations.filter((item) => hiddenAnnotationIds.has(item.id)).length} 个已隐藏）` : ""}</span>
        {polygonPoints.length > 0 && <span>{polygonPoints.length} 个多边形点</span>}
      </div>
    </section>
  );
}

function EditableObb({ annotation, stageObb, selected, panModifier, setNodeRef, onSelect, onChange }: { annotation: Annotation; stageObb: OBB; selected: boolean; panModifier: boolean; setNodeRef: (node: Konva.Rect | null) => void; onSelect: () => void; onChange: (obb: OBB) => void }) {
  return <Rect ref={setNodeRef} x={stageObb.cx} y={stageObb.cy} width={stageObb.width} height={stageObb.height} offsetX={stageObb.width / 2} offsetY={stageObb.height / 2} rotation={stageObb.angle} stroke={annotation.color} strokeWidth={selected ? 3 : 2} strokeScaleEnabled={false} fill={selected ? `${annotation.color}22` : "transparent"} draggable={!panModifier} onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }} onClick={onSelect} onTap={onSelect} onDragEnd={(event) => onChange({ ...stageObb, cx: event.target.x(), cy: event.target.y() })} onTransformEnd={(event) => { const node = event.target; const scaleX = node.scaleX(); const scaleY = node.scaleY(); node.scaleX(1); node.scaleY(1); onChange({ cx: node.x(), cy: node.y(), width: Math.abs(node.width() * scaleX), height: Math.abs(node.height() * scaleY), angle: node.rotation() }); }} />;
}

function EditableBbox({ annotation, scale, selected, panModifier, setNodeRef, onSelect, onChange }: { annotation: Annotation; scale: { x: number; y: number }; selected: boolean; panModifier: boolean; setNodeRef: (node: Konva.Rect | null) => void; onSelect: () => void; onChange: (bbox: BBox) => void }) {
  const bbox = annotation.bbox;
  if (!bbox) return null;
  const stageBox = { x: bbox.x * scale.x, y: bbox.y * scale.y, width: bbox.width * scale.x, height: bbox.height * scale.y };
  return <Rect ref={setNodeRef} {...stageBox} stroke={annotation.color} strokeWidth={selected ? 3 : 2} strokeScaleEnabled={false} fill={selected ? `${annotation.color}22` : "transparent"} draggable={!panModifier} onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }} onClick={onSelect} onTap={onSelect} onDragEnd={(event) => onChange({ ...stageBox, x: event.target.x(), y: event.target.y() })} onTransformEnd={(event) => { const node = event.target; const scaleX = node.scaleX(); const scaleY = node.scaleY(); node.scaleX(1); node.scaleY(1); onChange({ x: node.x(), y: node.y(), width: Math.abs(node.width() * scaleX), height: Math.abs(node.height() * scaleY) }); }} />;
}

function displayBox(box: BBox) {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function toDraft(annotation: Annotation): AnnotationDraft {
  return { id: annotation.id, class_id: annotation.class_id, type: annotation.type, bbox: annotation.bbox ?? undefined, polygon: annotation.polygon ?? undefined, obb: annotation.obb ?? undefined, keypoints: annotation.keypoints ?? undefined, source: annotation.source };
}

function AnnotationShape({ annotation, scale, onSelect }: { annotation: Annotation; scale: { x: number; y: number }; onSelect: () => void }) {
  if (annotation.type === "bbox" && annotation.bbox) {
    return <Rect x={annotation.bbox.x * scale.x} y={annotation.bbox.y * scale.y} width={annotation.bbox.width * scale.x} height={annotation.bbox.height * scale.y} stroke={annotation.color} strokeWidth={2} strokeScaleEnabled={false} />;
  }
  if (annotation.polygon) {
    return <Line points={annotation.polygon.flatMap(([x, y]) => [x * scale.x, y * scale.y])} closed stroke={annotation.color} fill={`${annotation.color}33`} strokeWidth={2} strokeScaleEnabled={false} onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }} onClick={onSelect} onTap={onSelect} />;
  }
  return null;
}

function EditablePolygon({ annotation, scale, zoom, panModifier, onSelect, onMoveVertex, onDeleteVertex, onInsertVertex }: { annotation: Annotation; scale: { x: number; y: number }; zoom: number; panModifier: boolean; onSelect: () => void; onMoveVertex: (index: number, point: [number, number]) => void; onDeleteVertex: (index: number) => void; onInsertVertex: (point: [number, number]) => void }) {
  const polygon = annotation.polygon;
  if (!polygon) return null;
  return (
    <>
      <Line
        points={polygon.flatMap(([x, y]) => [x * scale.x, y * scale.y])}
        closed
        stroke={annotation.color}
        fill={`${annotation.color}33`}
        strokeWidth={2}
        strokeScaleEnabled={false}
        onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }}
        onClick={onSelect}
        onTap={onSelect}
        onDblClick={(event) => {
          event.cancelBubble = true;
          const position = event.target.getRelativePointerPosition();
          if (position) onInsertVertex([position.x, position.y]);
        }}
        onDblTap={(event) => {
          event.cancelBubble = true;
          const position = event.target.getRelativePointerPosition();
          if (position) onInsertVertex([position.x, position.y]);
        }}
      />
      {polygon.map((vertex, index) => (
        <Circle
          key={index}
          x={vertex[0] * scale.x}
          y={vertex[1] * scale.y}
          radius={Math.max(3.5 / zoom, 1.5)}
          fill="#fff"
          stroke={annotation.color}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          draggable={!panModifier}
          onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }}
          onDblClick={() => onDeleteVertex(index)}
          onDblTap={() => onDeleteVertex(index)}
          onDragEnd={(event) => onMoveVertex(index, [event.target.x(), event.target.y()])}
        />
      ))}
    </>
  );
}

function newDraftId(): string { return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

/** 新建 pose 标注时把关键点均匀铺在框内（v=0 未标注），由用户逐个拖到目标位置。 */
function initialKeypoints(box: BBox, count: number): [number, number, number][] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = columns === 1 ? box.x + box.width / 2 : box.x + ((column + 0.5) / columns) * box.width;
    const y = rows === 1 ? box.y + box.height / 2 : box.y + ((row + 0.5) / rows) * box.height;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, 0] as [number, number, number];
  });
}

function keypointFill(visibility: number, color: string): { fill: string; stroke: string; dash?: number[] } {
  if (visibility === 0) return { fill: "rgba(255,255,255,.15)", stroke: color, dash: [2, 2] };
  if (visibility === 1) return { fill: "#fff", stroke: color };
  return { fill: color, stroke: "#fff" };
}

function PoseShape({ annotation, scale, zoom, selected, panModifier, skeleton, kptNames, setNodeRef, onSelect, onChange, onMoveKeypoint, onToggleKeypoint }: {
  annotation: Annotation;
  scale: { x: number; y: number };
  zoom: number;
  selected: boolean;
  panModifier: boolean;
  skeleton: number[][] | null;
  kptNames: (string | null)[] | null;
  setNodeRef: (node: Konva.Rect | null) => void;
  onSelect: () => void;
  onChange: (bbox: BBox) => void;
  onMoveKeypoint: (index: number, point: [number, number]) => void;
  onToggleKeypoint: (index: number) => void;
}) {
  const bbox = annotation.bbox;
  const keypoints = annotation.keypoints ?? [];
  if (!bbox) return null;
  const stageBox = { x: bbox.x * scale.x, y: bbox.y * scale.y, width: bbox.width * scale.x, height: bbox.height * scale.y };
  const labeled = (index: number) => keypoints[index] && keypoints[index][2] > 0;
  return (
    <>
      <Rect
        ref={setNodeRef}
        {...stageBox}
        stroke={annotation.color}
        strokeWidth={selected ? 3 : 2}
        strokeScaleEnabled={false}
        fill={selected ? `${annotation.color}18` : "transparent"}
        draggable={!panModifier}
        onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(event) => onChange({ ...stageBox, x: event.target.x(), y: event.target.y() })}
        onTransformEnd={(event) => { const node = event.target; const scaleX = node.scaleX(); const scaleY = node.scaleY(); node.scaleX(1); node.scaleY(1); onChange({ x: node.x(), y: node.y(), width: Math.abs(node.width() * scaleX), height: Math.abs(node.height() * scaleY) }); }}
      />
      {(skeleton ?? []).filter(([start, end]) => labeled(start) && labeled(end)).map(([start, end], index) => (
        <Line
          key={`edge-${index}`}
          points={[keypoints[start][0] * scale.x, keypoints[start][1] * scale.y, keypoints[end][0] * scale.x, keypoints[end][1] * scale.y]}
          stroke={annotation.color}
          opacity={0.75}
          strokeWidth={2}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}
      {keypoints.map((keypoint, index) => {
        const style = keypointFill(keypoint[2], annotation.color);
        const editable = selected && !panModifier;
        return (
          <Circle
            key={`kpt-${index}`}
            x={keypoint[0] * scale.x}
            y={keypoint[1] * scale.y}
            radius={Math.max(4 / zoom, 2)}
            {...style}
            strokeWidth={selected ? 2 : 1.5}
            strokeScaleEnabled={false}
            draggable={editable}
            onMouseDown={(event) => { if (panModifierActive(event.evt)) return; event.cancelBubble = true; onSelect(); }}
            onDragEnd={editable ? (event) => onMoveKeypoint(index, [event.target.x(), event.target.y()]) : undefined}
            onDblClick={editable ? (event) => { event.cancelBubble = true; onToggleKeypoint(index); } : undefined}
            onDblTap={editable ? (event) => { event.cancelBubble = true; onToggleKeypoint(index); } : undefined}
          />
        );
      })}
      {selected && keypoints.map((keypoint, index) => (
        <PoseIndexLabel key={`label-${index}`} x={keypoint[0] * scale.x} y={keypoint[1] * scale.y} text={kptNames?.[index] || String(index)} />
      ))}
    </>
  );
}

/** 关键点序号/名称：放在关键点右上的小标签，便于在密集骨架中辨识顶点。 */
function PoseIndexLabel({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <Text
      x={x + 7}
      y={y - 19}
      text={text}
      fill="#e2e8f0"
      fontSize={11}
      fontStyle="600"
      padding={2}
      listening={false}
    />
  );
}
