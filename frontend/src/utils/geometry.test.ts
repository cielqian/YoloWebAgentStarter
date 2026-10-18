import { describe, expect, it } from "vitest";
import { clampBBoxToImage, clampOBBToImage, nearestEdgeOnPolygon, normalizeAngle, normalizeBBox, obbCorners, simplifyPolygon, toOriginalPoint } from "./geometry";

describe("annotation geometry helpers", () => {
  it("normalizes a drag in any direction", () => {
    expect(normalizeBBox([80, 60], [20, 10])).toEqual({ x: 20, y: 10, width: 60, height: 50 });
  });

  it("maps display coordinates back to absolute image pixels", () => {
    expect(toOriginalPoint([50, 25], 100, 50, 1000, 500)).toEqual([500, 250]);
  });

  it("keeps edited boxes within the image bounds", () => {
    expect(clampBBoxToImage({ x: -10, y: 70, width: 140, height: 20 }, 100, 80)).toEqual({ x: 0, y: 60, width: 100, height: 20 });
  });

  it("normalizes OBB rotation while keeping edited corners inside the image", () => {
    const obb = clampOBBToImage({ cx: 5, cy: 5, width: 80, height: 60, angle: 270 }, 100, 80);
    expect(obb.angle).toBe(-90);
    expect(obb.width).toBe(80);
    expect(obb.height).toBe(60);
    for (const [x, y] of obbCorners(obb)) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(100 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(80 + 1e-9);
    }
    expect(normalizeAngle(-270)).toBe(90);
  });

  it("simplifies a closed polygon while keeping its shape", () => {
    const dense: [number, number][] = [[0, 0], [5, 0], [10, 0], [15, 0], [20, 0], [20, 20], [10, 22], [0, 20]];
    expect(simplifyPolygon(dense, 2)).toEqual([[0, 0], [20, 0], [20, 20], [0, 20]]);
    expect(simplifyPolygon(dense, 0)).toEqual(dense);
    expect(simplifyPolygon([[0, 0], [10, 0], [0, 10]], 5)).toEqual([[0, 0], [10, 0], [0, 10]]);
  });

  it("finds the nearest edge projection for inserting a vertex", () => {
    const triangle: [number, number][] = [[10, 10], [50, 10], [50, 40]];
    expect(nearestEdgeOnPolygon(triangle, [30, 15])).toEqual({ index: 0, point: [30, 10], distance: 5 });
    expect(nearestEdgeOnPolygon(triangle, [120, 15])).toEqual({ index: 1, point: [50, 15], distance: 70 });
    expect(nearestEdgeOnPolygon([[5, 5]], [0, 0])).toBeNull();
  });
});
