// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetHome } from "./App";
import { api } from "./api/client";
import type { Dataset } from "./types";

vi.mock("./api/client", () => ({
  api: {
    listDatasetVersions: vi.fn(),
  },
  apiUrl: (path: string) => path,
}));

const dataset: Dataset = { id: "ds-1", name: "vehicles", description: null, task_type: "detect", image_count: 5, annotated_image_count: 3, class_count: 1, latest_version_number: 2, active_version_number: 2, created_at: "", updated_at: "" };
const versions = [
  { id: "v-2", dataset_id: "ds-1", version_number: 2, note: "第二轮", is_active: true, image_count: 5, annotation_count: 6, class_count: 1, created_at: "", updated_at: "" },
  { id: "v-1", dataset_id: "ds-1", version_number: 1, note: null, is_active: false, image_count: 3, annotation_count: 3, class_count: 1, created_at: "", updated_at: "" },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(api.listDatasetVersions).mockResolvedValue(versions);
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

const clickButton = async (label: string) => {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => (item.textContent ?? "").includes(label));
  expect(button, `button ${label} should exist`).toBeDefined();
  await act(async () => { button?.click(); });
  await act(async () => {});
};

describe("DatasetHome create dialog clone mode", () => {
  it("clones a chosen version into a new dataset with a pre-filled name", async () => {
    const onClone = vi.fn();
    await act(async () => {
      root?.render(<DatasetHome datasets={[dataset]} busy={false} onCreate={vi.fn()} onClone={onClone} onImport={vi.fn()}
        onFtpImport={vi.fn()}
        onCancelImport={vi.fn()}
        onMergeYolo={vi.fn()}
        onMergeYoloFromFtp={vi.fn()} onValidate={vi.fn()} onQuality={vi.fn()} onContinueAnnotation={vi.fn()} onUpload={vi.fn()} onTrain={vi.fn()} onDuplicates={vi.fn()} onSourceSync={vi.fn()} onDelete={vi.fn()} />);
    });
    await clickButton("新建数据集");
    await clickButton("从现有版本克隆");

    expect(api.listDatasetVersions).toHaveBeenCalledWith("ds-1");
    const nameInput = container?.querySelector<HTMLInputElement>("input[placeholder='例如：my-dataset-v1']");
    expect(nameInput?.value).toBe("vehicles-v2");
    const selects = container?.querySelectorAll<HTMLSelectElement>("select");
    expect(selects?.[1].value).toBe("v-2");
    await clickButton("克隆数据集");

    expect(onClone).toHaveBeenCalledWith("ds-1", "v-2", "vehicles-v2");
  });

  it("keeps the clone button disabled until versions are loaded", async () => {
    vi.mocked(api.listDatasetVersions).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      root?.render(<DatasetHome datasets={[dataset]} busy={false} onCreate={vi.fn()} onClone={vi.fn()} onImport={vi.fn()}
        onFtpImport={vi.fn()}
        onCancelImport={vi.fn()}
        onMergeYolo={vi.fn()}
        onMergeYoloFromFtp={vi.fn()} onValidate={vi.fn()} onQuality={vi.fn()} onContinueAnnotation={vi.fn()} onUpload={vi.fn()} onTrain={vi.fn()} onDuplicates={vi.fn()} onSourceSync={vi.fn()} onDelete={vi.fn()} />);
    });
    await clickButton("新建数据集");
    await clickButton("从现有版本克隆");

    const submit = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "克隆数据集");
    expect(submit?.disabled).toBe(true);
    expect(container?.textContent).toContain("正在加载版本…");
  });

  it("clones the live workspace for a dataset without versions", async () => {
    const unversioned: Dataset = { ...dataset, id: "ds-9", name: "raw", latest_version_number: null, active_version_number: null };
    const onClone = vi.fn();
    await act(async () => {
      root?.render(<DatasetHome datasets={[unversioned]} busy={false} onCreate={vi.fn()} onClone={onClone} onImport={vi.fn()}
        onFtpImport={vi.fn()}
        onCancelImport={vi.fn()}
        onMergeYolo={vi.fn()}
        onMergeYoloFromFtp={vi.fn()} onValidate={vi.fn()} onQuality={vi.fn()} onContinueAnnotation={vi.fn()} onUpload={vi.fn()} onTrain={vi.fn()} onDuplicates={vi.fn()} onSourceSync={vi.fn()} onDelete={vi.fn()} />);
    });
    await clickButton("新建数据集");
    await clickButton("从现有版本克隆");

    expect(api.listDatasetVersions).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("将克隆其当前工作区");
    const nameInput = container?.querySelector<HTMLInputElement>("input[placeholder='例如：my-dataset-v1']");
    expect(nameInput?.value).toBe("raw-副本");
    expect(container?.querySelectorAll<HTMLSelectElement>("select")).toHaveLength(1);
    await clickButton("克隆数据集");

    expect(onClone).toHaveBeenCalledWith("ds-9", null, "raw-副本");
  });
});
