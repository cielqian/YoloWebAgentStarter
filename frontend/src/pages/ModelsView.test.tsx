// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsView } from "./ModelsView";
import type { Dataset, ModelVersion } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listModels: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listModelEvaluations: vi.fn().mockResolvedValue([]),
    updateModel: vi.fn(),
    archiveModel: vi.fn(),
    restoreModel: vi.fn(),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    exportModelOnnx: vi.fn(),
    convertModelToOm: vi.fn(),
    listOmNodes: vi.fn().mockResolvedValue([]),
    compareModels: vi.fn(),
    testModel: vi.fn(),
  },
}));

const detectSet: Dataset = { id: "ds-1", name: "detect-set", description: null, task_type: "detect", image_count: 4, annotated_image_count: 4, class_count: 1, created_at: "", updated_at: "" };
const segmentSet: Dataset = { id: "ds-2", name: "segment-set", description: null, task_type: "segment", image_count: 2, annotated_image_count: 2, class_count: 1, created_at: "", updated_at: "" };

function modelFixture(overrides: Partial<ModelVersion>): ModelVersion {
  return {
    id: "model-1",
    name: "run-a (best)",
    version: "train-best",
    dataset_id: "ds-1",
    training_task_id: "train-1",
    source_model_id: null,
    source: "training_task",
    artifact_type: "best",
    format: "pt",
    task_type: "detect",
    engine_type: "ultralytics",
    model_path: "/managed/models/model-1/best.pt",
    base_model: "yolov8n.pt",
    status: "active",
    precision: 0.9,
    recall: 0.8,
    map50: 0.95,
    map50_95: 0.7,
    metrics_json: {},
    notes: "",
    archived_at: null,
    created_at: "2026-10-20T10:00:00Z",
    updated_at: "2026-10-20T10:00:00Z",
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("ModelsView global registry", () => {
  it("renders without a selected dataset and labels rows by each model's dataset", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        modelFixture({ id: "model-1", name: "run-a (best)", dataset_id: "ds-1" }),
        modelFixture({ id: "model-2", name: "run-b (best)", dataset_id: "ds-2", task_type: "segment" }),
        modelFixture({ id: "model-3", name: "orphan (best)", dataset_id: null }),
      ],
      total: 3,
    });
    await act(async () => { root?.render(<ModelsView datasets={[detectSet, segmentSet]} />); });

    expect(container?.textContent).toContain("全部数据集");
    expect(container?.textContent).toContain("3 个模型");
    expect(container?.textContent).toContain("run-a (best)");
    expect(container?.textContent).toContain("detect-set");
    expect(container?.textContent).toContain("segment-set");
    expect(container?.textContent).toContain("未关联数据集");
  });

  it("shows the empty state with no models and no datasets", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    await act(async () => { root?.render(<ModelsView datasets={[]} />); });
    expect(container?.textContent).toContain("暂无模型");
    expect(container?.textContent).toContain("完成训练后");
  });
});
