import { describe, expect, it } from "vitest";
import type { TrainingDevice } from "../types";
import { defaultModelFor, defaultRemoteSelection, modelChoicesFor } from "./helpers";

describe("training model choices", () => {
  it("offers only the YOLOv8 family for detection", () => {
    expect(modelChoicesFor("detect").map((item) => item.value)).toEqual(["yolov8n.pt", "yolov8s.pt"]);
  });

  it("keeps task-specific suffixes for segmentation, OBB and classification", () => {
    expect(modelChoicesFor("segment").map((item) => item.value)).toContain("yolov8n-seg.pt");
    expect(modelChoicesFor("obb").map((item) => item.value)).toContain("yolov8s-obb.pt");
    expect(modelChoicesFor("classify").map((item) => item.value)).toContain("yolov8n-cls.pt");
  });

  it("defaults new tasks to yolov8n weights", () => {
    expect(defaultModelFor("detect")).toBe("yolov8n.pt");
    expect(defaultModelFor("segment")).toBe("yolov8n-seg.pt");
  });
});

describe("default remote selection", () => {
  const dev = (id: string, type: TrainingDevice["type"], index: number | null, status: TrainingDevice["status"], node_id = "n1"): TrainingDevice =>
    ({ id: `${node_id}:${id}`, type, name: "x", index, memory_total_mb: null, memory_free_mb: null, status, node_id, node_name: "gpu-1" }) as TrainingDevice;

  it("picks a single free accelerator, skipping busy ones", () => {
    const devices = [
      dev("cpu", "cpu", null, "available"),
      dev("cuda:0", "cuda", 0, "busy"),
      dev("cuda:1", "cuda", 1, "available"),
      dev("cuda:2", "cuda", 2, "available"),
    ];
    expect(defaultRemoteSelection(devices)).toEqual({ node_id: "n1", node_device: "cuda:1" });
  });

  it("falls back to the first accelerator when all are busy", () => {
    const devices = [dev("cuda:0", "cuda", 0, "busy"), dev("cuda:1", "cuda", 1, "busy")];
    expect(defaultRemoteSelection(devices)).toEqual({ node_id: "n1", node_device: "cuda:0" });
  });

  it("returns null without accelerators", () => {
    expect(defaultRemoteSelection([dev("cpu", "cpu", null, "available")])).toBeNull();
  });
});
