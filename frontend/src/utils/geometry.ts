import type { BBox, OBB } from "../types";

export const MIN_SHAPE_SIZE = 3;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeBBox(start: [number, number], end: [number, number]): BBox {
  return {
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]),
    height: Math.abs(end[1] - start[1]),
  };
}

/** Keep a persisted axis-aligned box inside the source image. */
export function clampBBoxToImage(bbox: BBox, imageWidth: number, imageHeight: number): BBox {
  const width = Math.min(Math.max(bbox.width, MIN_SHAPE_SIZE), imageWidth);
  const height = Math.min(Math.max(bbox.height, MIN_SHAPE_SIZE), imageHeight);
  return {
    x: clamp(bbox.x, 0, Math.max(0, imageWidth - width)),
    y: clamp(bbox.y, 0, Math.max(0, imageHeight - height)),
    width,
    height,
  };
}

export function toOriginalPoint(
  point: [number, number],
  displayWidth: number,
  displayHeight: number,
  imageWidth: number,
  imageHeight: number,
): [number, number] {
  return [
    clamp((point[0] / displayWidth) * imageWidth, 0, imageWidth),
    clamp((point[1] / displayHeight) * imageHeight, 0, imageHeight),
  ];
}

export function normalizeAngle(angle: number): number {
  const normalized = ((angle % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
}

function segmentDistance(point: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function douglasPeucker(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2) return points;
  let index = 0;
  let maxDistance = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = segmentDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [points[0], points[points.length - 1]];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Douglas-Peucker 抽稀闭环多边形：以离起点最远的顶点把环拆成两条链分别处理，避免闭口边一侧失真。 */
export function simplifyPolygon(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 3 || tolerance <= 0) return points;
  let split = 0;
  let maxDistance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const distance = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      split = i;
    }
  }
  const first = douglasPeucker(points.slice(0, split + 1), tolerance);
  const second = douglasPeucker([points[split], ...points.slice(split + 1), points[0]], tolerance);
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  return merged.length >= 3 ? merged : points;
}

/** 找 target 到多边形各边最近的投影点，返回插入位置（第 index 条边之后）与距离。 */
export function nearestEdgeOnPolygon(points: [number, number][], target: [number, number]): { index: number; point: [number, number]; distance: number } | null {
  if (points.length < 2) return null;
  let best: { index: number; point: [number, number]; distance: number } | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : clamp(((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / lengthSquared, 0, 1);
    const point: [number, number] = [a[0] + t * dx, a[1] + t * dy];
    const distance = Math.hypot(target[0] - point[0], target[1] - point[1]);
    if (best === null || distance < best.distance) best = { index: i, point, distance };
  }
  return best;
}

export function obbCorners(obb: OBB): [number, number][] {
  const radians = (obb.angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const halfWidth = obb.width / 2;
  const halfHeight = obb.height / 2;
  return ([-1, 1, 1, -1] as const).map((horizontal, index) => {
    const vertical = index < 2 ? -1 : 1;
    return [
      obb.cx + horizontal * halfWidth * cosine - vertical * halfHeight * sine,
      obb.cy + horizontal * halfWidth * sine + vertical * halfHeight * cosine,
    ];
  });
}

/** Keep a persisted OBB valid while preserving its centre/size/angle contract. */
export function clampOBBToImage(obb: OBB, imageWidth: number, imageHeight: number): OBB {
  let resolved = {
    ...obb,
    width: Math.min(Math.max(obb.width, MIN_SHAPE_SIZE), imageWidth),
    height: Math.min(Math.max(obb.height, MIN_SHAPE_SIZE), imageHeight),
    angle: normalizeAngle(obb.angle),
  };
  const radians = (resolved.angle * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  let halfX = (resolved.width * cosine + resolved.height * sine) / 2;
  let halfY = (resolved.width * sine + resolved.height * cosine) / 2;
  const fitScale = Math.min(1, imageWidth / Math.max(halfX * 2, MIN_SHAPE_SIZE), imageHeight / Math.max(halfY * 2, MIN_SHAPE_SIZE));
  if (fitScale < 1) {
    resolved = { ...resolved, width: Math.max(MIN_SHAPE_SIZE, resolved.width * fitScale), height: Math.max(MIN_SHAPE_SIZE, resolved.height * fitScale) };
    halfX = (resolved.width * cosine + resolved.height * sine) / 2;
    halfY = (resolved.width * sine + resolved.height * cosine) / 2;
  }
  return {
    ...resolved,
    cx: clamp(resolved.cx, Math.min(halfX, imageWidth / 2), Math.max(imageWidth - halfX, imageWidth / 2)),
    cy: clamp(resolved.cy, Math.min(halfY, imageHeight / 2), Math.max(imageHeight - halfY, imageHeight / 2)),
  };
}
