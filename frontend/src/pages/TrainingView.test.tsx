// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingView } from "./TrainingView";
import type { Dataset, TrainingTask } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listTrainingTasks: vi.fn().mockResolvedValue({ items: [] }),
    listWeights: vi.fn().mockResolvedValue({ items: [] }),
    listTrainingDevices: vi.fn().mockResolvedValue({ items: [] }),
    createTrainingTask: vi.fn(),
    stopTrainingTask: vi.fn(),
    deleteTrainingTask: vi.fn().mockResolvedValue(undefined),
    resumeTrainingTask: vi.fn(),
    getTrainingLogs: vi.fn().mockResolvedValue({ task_id: "", logs: "", line_count: 0 }),
    getTrainingSummary: vi.fn().mockResolvedValue({
      task_id: "",
      status: "pending",
      training_config: {},
      dataset: {},
      progress: { epoch: 0, total_epochs: 0, percent: 0 },
      metrics: {},
      checkpoints: {},
      log_summary: { line_count: 0, tail: [] },
      risks: [],
      next_steps: [],
    }),
    downloadCheckpointUrl: vi.fn().mockReturnValue("#"),
    autoSplitImages: vi.fn(),
  },
}));

const detect: Dataset = { id: "ds-detect", name: "detect-set", description: null, task_type: "detect", image_count: 4, annotated_image_count: 4, class_count: 1, created_at: "", updated_at: "" };
const segment: Dataset = { id: "ds-segment", name: "segment-set", description: null, task_type: "segment", image_count: 2, annotated_image_count: 2, class_count: 1, created_at: "", updated_at: "" };

const finishedTask: TrainingTask = {
  id: "train-finished",
  dataset_id: "ds-detect",
  profile_id: null,
  name: "smoke-run",
  status: "completed",
  task_type: "detect",
  model_name: "yolo11n.pt",
  model_path: "yolo11n.pt",
  epochs: 2,
  img_size: 640,
  batch_size: 4,
  device: "cpu",
  node_id: null,
  workers: 2,
  val_ratio: 0.2,
  seed: 42,
  optimizer: null,
  lr0: null,
  patience: null,
  command_preview: null,
  export_path: null,
  data_yaml_path: null,
  run_dir: null,
  logs_path: null,
  summary_path: null,
  best_model_path: null,
  last_model_path: null,
  progress_epoch: 2,
  progress_total_epochs: 2,
  progress_percent: 100,
  metrics_json: { map50: 0.81 },
  error_message: null,
  stop_requested: false,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:05:00Z",
  started_at: "2026-10-20T10:00:00Z",
  finished_at: "2026-10-20T10:05:00Z",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

async function clickCreate() {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((item) => item.textContent?.includes("新建训练"));
  expect(button).toBeDefined();
  await act(async () => { button?.click(); });
}

describe("TrainingView list-first workspace", () => {
  it("shows the record list by default with a create entry", async () => {
    await act(async () => { root?.render(<TrainingView datasets={[detect]} dataset={detect} onDatasetChange={vi.fn()} />); });
    expect(container?.querySelector("#experiment-history")).toBeTruthy();
    expect(container?.querySelector(".training-ws-history-empty")).toBeTruthy();
    expect(container?.textContent).toContain("新建训练");
    expect(container?.querySelector("#training-config-anchor")).toBeFalsy();
  });

  it("opens the full config workspace from the create entry", async () => {
    await act(async () => { root?.render(<TrainingView datasets={[detect]} dataset={detect} onDatasetChange={vi.fn()} />); });
    await clickCreate();
    expect(container?.querySelector("#training-config-anchor")).toBeTruthy();
    expect(container?.querySelector(".training-dataset-rail")).toBeTruthy();
    expect(container?.textContent).toContain("开始训练");
  });

  it("opens the config workspace directly when a dataset jumps in", async () => {
    await act(async () => {
      root?.render(
        <TrainingView
          datasets={[detect]}
          dataset={detect}
          onDatasetChange={vi.fn()}
          autoCreateDatasetId={detect.id}
          onAutoCreateConsumed={vi.fn()}
        />,
      );
    });
    expect(container?.querySelector("#training-config-anchor")).toBeTruthy();
  });

  it("focuses a task detail from a deep link while staying in list mode", async () => {
    const { api } = await import("../api/client");
    (api.listTrainingTasks as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [finishedTask] });
    await act(async () => {
      root?.render(
        <TrainingView
          datasets={[detect]}
          dataset={detect}
          onDatasetChange={vi.fn()}
          focusTaskId="train-finished"
          onFocusTaskConsumed={vi.fn()}
        />,
      );
    });
    expect(container?.querySelector("#training-task-detail")).toBeTruthy();
    expect(container?.querySelector(".modal-backdrop")).toBeTruthy();
    expect(container?.textContent).toContain("smoke-run");
    expect(container?.querySelector("#experiment-history")).toBeTruthy();
  });

  it("deletes a finished record from the row action", async () => {
    const { api } = await import("../api/client");
    (api.listTrainingTasks as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [finishedTask] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => { root?.render(<TrainingView datasets={[detect]} dataset={detect} onDatasetChange={vi.fn()} />); });
    const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "删除");
    expect(button).toBeDefined();
    await act(async () => { button?.click(); });
    expect(api.deleteTrainingTask).toHaveBeenCalledWith("train-finished");
    confirmSpy.mockRestore();
  });

  it("allows selecting the dataset used for a new training task", async () => {
    const onDatasetChange = vi.fn();
    await act(async () => { root?.render(<TrainingView datasets={[detect, segment]} dataset={detect} onDatasetChange={onDatasetChange} />); });
    await clickCreate();
    const select = Array.from(container?.querySelectorAll<HTMLSelectElement>("select") ?? []).find((item) => item.value === detect.id);
    expect(select).toBeDefined();
    await act(async () => { if (select) { select.value = segment.id; select.dispatchEvent(new Event("change", { bubbles: true })); } });
    expect(onDatasetChange).toHaveBeenCalledWith(segment);
  });

  it("shows the task list without any dataset and blocks create with guidance", async () => {
    const { api } = await import("../api/client");
    (api.listTrainingTasks as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
    await act(async () => { root?.render(<TrainingView datasets={[]} onDatasetChange={vi.fn()} />); });
    expect(container?.querySelector("#experiment-history")).toBeTruthy();
    expect(container?.textContent).toContain("还没有训练记录");
    await clickCreate();
    // 无数据集：停留在列表，提示先创建/导入数据集
    expect(container?.querySelector("#training-config-anchor")).toBeFalsy();
    expect(container?.textContent).toContain("请先创建或导入一个数据集");
  });

  it("falls back to the first dataset when none is selected", async () => {
    await act(async () => { root?.render(<TrainingView datasets={[detect, segment]} onDatasetChange={vi.fn()} />); });
    await clickCreate();
    expect(container?.querySelector("#training-config-anchor")).toBeTruthy();
    expect(container?.textContent).toContain("detect-set");
  });
});
