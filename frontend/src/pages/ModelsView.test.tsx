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
    listFtp: vi.fn().mockResolvedValue({ path: "/", entries: [
      { name: "models", path: "/models", is_dir: true, size: null, modified: null },
      { name: "readme.txt", path: "/readme.txt", is_dir: false, size: 10, modified: null },
    ] }),
    uploadFtp: vi.fn().mockResolvedValue({ uploaded: [] }),
    compareModels: vi.fn(),
    testModel: vi.fn(),
  },
  apiUrl: (path: string) => path,
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
  it("lists datasets first and drills into versions and format sections", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        modelFixture({ id: "model-v2", name: "v2-best", dataset_id: "ds-1", dataset_version_number: 2 }),
        modelFixture({ id: "model-v1", name: "v1-best", dataset_id: "ds-1", dataset_version_number: 1 }),
        modelFixture({ id: "model-2", name: "run-b (best)", dataset_id: "ds-2", task_type: "segment" }),
        modelFixture({ id: "model-3", name: "orphan (best)", dataset_id: null }),
      ],
      total: 4,
    });
    await act(async () => { root?.render(<ModelsView datasets={[detectSet, segmentSet]} />); });
    await act(async () => {});

    // 第一层:数据集列表
    expect(container?.textContent).toContain("4 个模型");
    expect(container?.textContent).toContain("detect-set");
    expect(container?.textContent).toContain("segment-set");
    expect(container?.textContent).toContain("未关联数据集");

    // 下钻数据集 → 版本列表
    const datasetRow = Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? []).find((row) => row.textContent?.includes("detect-set"));
    await act(async () => { datasetRow?.click(); });
    await act(async () => {});
    expect(container?.textContent).toContain("选择版本查看 PT / ONNX / OM 模型");

    // 下钻版本 v2 → 三格式分区
    const v2 = Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? []).find((row) => row.textContent?.startsWith("v2"));
    await act(async () => { v2?.click(); });
    await act(async () => {});
    expect(container?.textContent).toContain("PT 模型");
    expect(container?.textContent).toContain("ONNX 模型");
    expect(container?.textContent).toContain("OM 模型（华为昇腾）");
    expect(container?.textContent).toContain("v2-best");
    expect(container?.textContent).toContain("该版本暂无 ONNX");
    expect(container?.textContent).not.toContain("v1-best");

    // 面包屑回退到数据集层
    const crumbDatasets = Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-crumb button") ?? []).find((button) => button.textContent === "模型库");
    await act(async () => { crumbDatasets?.click(); });
    await act(async () => {});
    expect(container?.textContent).toContain("选择数据集查看其各版本的模型");
  });

  it("hides detail and delete actions while a model is converting", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        modelFixture({
          id: "om-conv",
          name: "detect.om",
          dataset_id: "ds-1",
          dataset_version_number: 1,
          format: "om",
          artifact_type: "om",
          status: "converting",
        }),
      ],
      total: 1,
    });
    await act(async () => { root?.render(<ModelsView datasets={[detectSet]} />); });
    await act(async () => {});
    await act(async () => { (Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? [])[0])?.click(); });
    await act(async () => {});
    await act(async () => { (Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? [])[0])?.click(); });
    await act(async () => {});

    expect(container?.textContent).toContain("转换进行中…");
    const row = container?.querySelector(`tr.converting`);
    expect(row?.textContent).not.toContain("详情");
    expect(row?.textContent).not.toContain("删除");
  });

  it("shows the empty state with no models and no datasets", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    await act(async () => { root?.render(<ModelsView datasets={[]} />); });
    expect(container?.textContent).toContain("暂无模型");
    expect(container?.textContent).toContain("完成训练后");
  });
});


describe("ModelsView save to FTP", () => {
  it("uploads the model file to the chosen FTP directory with a new name", async () => {
    const { api } = await import("../api/client");
    (api.listModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [modelFixture({ id: "model-1", name: "run-a (best)", dataset_id: "ds-1", dataset_version_number: 1 })],
      total: 1,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["model-bytes"]) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await act(async () => { root?.render(<ModelsView datasets={[detectSet]} />); });
      await act(async () => {});
      await act(async () => { (Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? [])[0])?.click(); });
      await act(async () => {});
      await act(async () => { (Array.from(container?.querySelectorAll<HTMLButtonElement>(".models-drill-row") ?? [])[0])?.click(); });
      await act(async () => {});

      const saveButton = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "转存FTP");
      expect(saveButton).toBeDefined();
      await act(async () => { saveButton?.click(); });
      await act(async () => {});

      expect(api.listFtp).toHaveBeenCalledWith("/");
      const nameInput = container?.querySelector<HTMLInputElement>(".ftp-save-name input");
      expect(nameInput?.value).toBe("best.pt");

      const submit = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "转存");
      await act(async () => { submit?.click(); });
      await act(async () => {});

      expect(fetchMock).toHaveBeenCalled();
      expect(api.uploadFtp).toHaveBeenCalledWith("/", [expect.any(File)]);
      const sent = (api.uploadFtp as ReturnType<typeof vi.fn>).mock.calls[0][1][0] as File;
      expect(sent.name).toBe("best.pt");
      expect(container?.querySelector(".ftp-picker-dialog")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
