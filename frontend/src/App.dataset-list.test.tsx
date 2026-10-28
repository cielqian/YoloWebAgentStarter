// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetHome } from "./App";
import type { Dataset } from "./types";

const dataset: Dataset = {
  id: "ds-1", name: "road-signs", description: null, task_type: "detect", image_count: 12,
  annotated_image_count: 6, class_count: 3, created_at: "2026-10-20T10:00:00Z", updated_at: "",
  import_state: null, latest_version_number: 2, latest_version_label: "v2", active_version_number: 2,
};

const secondDataset: Dataset = { ...dataset, id: "ds-2", name: "blade-photos" };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

function renderHome() {
  const props = {
    datasets: [dataset], busy: false, onCreate: vi.fn(), onClone: vi.fn(), onImport: vi.fn(), onFtpImport: vi.fn(),
    onCancelImport: vi.fn(), onMergeYolo: vi.fn(), onMergeYoloFromFtp: vi.fn(), onQuality: vi.fn(),
    onContinueAnnotation: vi.fn(), onUpload: vi.fn(), onTrain: vi.fn(), onDuplicates: vi.fn(), onSourceSync: vi.fn(),
    onDelete: vi.fn(),
  };
  return act(async () => { root?.render(<DatasetHome {...props} />); });
}

const button = (label: string) => Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])
  .find((item) => item.textContent === label);

describe("dataset list layout", () => {
  it("renders datasets as table rows with summary columns", async () => {
    await renderHome();
    expect(container?.querySelector(".dataset-list-head")).toBeTruthy();
    expect(container?.querySelector(".dataset-row")).toBeTruthy();
    expect(container?.querySelectorAll(".dataset-card").length).toBe(0);
    const head = container?.querySelector(".dataset-list-head")?.textContent ?? "";
    expect(head).toContain("标注进度");
    expect(head).toContain("创建时间");
    const row = container?.querySelector(".dataset-row")?.textContent ?? "";
    expect(row).toContain("road-signs");
    expect(row).toContain("12");
    expect(row).toContain("50%");
    expect(row).toContain("v2");
  });

  it("keeps primary actions in the row and expands details on demand", async () => {
    await renderHome();
    const detail = container?.querySelector(".dataset-row-detail");
    expect(detail?.classList.contains("open")).toBe(false);
    // 行内常用操作始终可见
    expect(button("继续标注")).toBeTruthy();
    expect(button("训练")).toBeTruthy();
    // 展开细节操作区
    await act(async () => { button("更多")?.click(); });
    expect(container?.querySelector(".dataset-row-detail")?.classList.contains("open")).toBe(true);
    await act(async () => { button("收起")?.click(); });
    expect(container?.querySelector(".dataset-row-detail")?.classList.contains("open")).toBe(false);
  });

  it("runs row actions from the list", async () => {
    const onTrain = vi.fn();
    const props = {
      datasets: [dataset], busy: false, onCreate: vi.fn(), onClone: vi.fn(), onImport: vi.fn(), onFtpImport: vi.fn(),
      onCancelImport: vi.fn(), onMergeYolo: vi.fn(), onMergeYoloFromFtp: vi.fn(), onQuality: vi.fn(),
      onContinueAnnotation: vi.fn(), onUpload: vi.fn(), onTrain, onDuplicates: vi.fn(), onSourceSync: vi.fn(),
      onDelete: vi.fn(),
    };
    await act(async () => { root?.render(<DatasetHome {...props} />); });
    act(() => { button("训练")?.click(); });
    expect(onTrain).toHaveBeenCalledWith(dataset);
    act(() => { button("版本管理")?.click(); });
    expect(container?.textContent).toContain("版本");
  });

  it("keeps 添加图片 in the default row actions", async () => {
    await renderHome();
    const rowActions = container?.querySelector(".dataset-row-actions");
    expect(rowActions?.textContent).toContain("添加图片");
    const detailActions = container?.querySelector(".dataset-row-detail-actions");
    expect(detailActions?.textContent).not.toContain("添加图片");
  });

  it("filters datasets by the search box", async () => {
    const props = {
      datasets: [dataset, secondDataset], busy: false, onCreate: vi.fn(), onClone: vi.fn(), onImport: vi.fn(), onFtpImport: vi.fn(),
      onCancelImport: vi.fn(), onMergeYolo: vi.fn(), onMergeYoloFromFtp: vi.fn(), onQuality: vi.fn(),
      onContinueAnnotation: vi.fn(), onUpload: vi.fn(), onTrain: vi.fn(), onDuplicates: vi.fn(), onSourceSync: vi.fn(),
      onDelete: vi.fn(),
    };
    await act(async () => { root?.render(<DatasetHome {...props} />); });
    expect(container?.querySelectorAll(".dataset-row")).toHaveLength(2);

    const search = container?.querySelector<HTMLInputElement>(".dataset-search");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(search, "blade");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container?.querySelectorAll(".dataset-row")).toHaveLength(1);
    expect(container?.querySelector(".dataset-row")?.textContent).toContain("blade-photos");
    expect(container?.textContent).toContain("1 / 2 个数据集");

    await act(async () => {
      setValue?.call(search, "不存在的名字");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container?.querySelectorAll(".dataset-row")).toHaveLength(0);
    expect(container?.textContent).toContain("没有匹配的数据集");

    await act(async () => { button("清空搜索")?.click(); });
    expect(container?.querySelectorAll(".dataset-row")).toHaveLength(2);
  });
});
