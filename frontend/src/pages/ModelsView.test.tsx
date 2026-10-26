// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsView } from "./ModelsView";
import type { Dataset, ModelVersion } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listModels: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listDatasetVersions: vi.fn().mockResolvedValue([]),
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

describe("ModelsView grouped by dataset and version", () => {
  it("renders the dataset tree, defaults to the busiest dataset, and shows format sections", async () => {
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
    await act(async () => {});

    expect(container?.textContent).toContain("3 个模型");
    expect(container?.textContent).toContain("detect-set");
    expect(container?.textContent).toContain("segment-set");
    expect(container?.textContent).toContain("未关联数据集");
    expect(container?.textContent).toContain("PT 模型");
    expect(container?.textContent).toContain("ONNX 模型");
    expect(container?.textContent).toContain("OM 模型（华为昇腾）");
    expect(container?.textContent).toContain("run-a (best)");
    expect(container?.textContent).toContain("该版本暂无 ONNX");
  });

  it("navigates versions within a dataset and filters models by version", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        modelFixture({ id: "model-v2", name: "v2-best", dataset_id: "ds-1", dataset_version_number: 2 }),
        modelFixture({ id: "model-v1", name: "v1-best", dataset_id: "ds-1", dataset_version_number: 1 }),
      ],
      total: 2,
    });
    await act(async () => { root?.render(<ModelsView datasets={[detectSet]} />); });
    await act(async () => {});

    // 默认选中最新版本 v2
    expect(container?.textContent).toContain("v2-best");
    expect(container?.querySelectorAll(".models-tree-version").length).toBeGreaterThanOrEqual(2);

    const v1 = Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-tree-version") ?? []).find((button) => button.textContent?.startsWith("v1"));
    expect(v1).toBeDefined();
    await act(async () => { v1?.click(); });
    await act(async () => {});
    expect(container?.textContent).toContain("v1-best");
    expect(container?.textContent).not.toContain("v2-best");
  });

  it("shows the empty state with no models and no datasets", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    await act(async () => { root?.render(<ModelsView datasets={[]} />); });
    expect(container?.textContent).toContain("暂无模型");
    expect(container?.textContent).toContain("完成训练后");
  });
});
