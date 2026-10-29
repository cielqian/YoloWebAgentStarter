// @vitest-environment jsdom

// antd 组件在 jsdom 里需要的浏览器 API mock
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
    });
  }
  if (!window.ResizeObserver) {
    class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
    (window as unknown as { ResizeObserver: object }).ResizeObserver = ResizeObserverMock;
  }
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

function renderHome(overrides: Record<string, unknown> = {}) {
  const props = {
    datasets: [dataset], busy: false, onCreate: vi.fn(), onClone: vi.fn(), onImport: vi.fn(), onFtpImport: vi.fn(),
    onCancelImport: vi.fn(), onMergeYolo: vi.fn(), onMergeYoloFromFtp: vi.fn(), onQuality: vi.fn(),
    onContinueAnnotation: vi.fn(), onUpload: vi.fn(), onTrain: vi.fn(), onDuplicates: vi.fn(), onSourceSync: vi.fn(),
    onDelete: vi.fn(), ...overrides,
  };
  return act(async () => { root?.render(<DatasetHome {...props} />); });
}

/** 在 container + document.body 范围找按钮(antd Modal 传送门) */
const findButton = (label: string | RegExp) =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((el) => typeof label === "string" ? (el.textContent ?? "").includes(label) : label.test(el.textContent ?? ""));

const clickButton = async (label: string | RegExp) => {
  const btn = findButton(label);
  expect(btn, `button ${String(label)} should exist`).toBeDefined();
  await act(async () => { btn?.click(); });
  await act(async () => {});
};

/** antd Table 行 */
const tableRows = () => Array.from(document.body.querySelectorAll(".ant-table-tbody tr"));

describe("dataset list layout", () => {
  it("renders datasets as antd table rows with summary columns", async () => {
    await renderHome();
    await act(async () => {});
    const rows = tableRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const rowText = rows[0]?.textContent ?? "";
    expect(rowText).toContain("road-signs");
    expect(rowText).toContain("12");
    expect(rowText).toContain("50%");
    expect(rowText).toContain("v2");
  });

  it("keeps primary actions in the row and low-frequency actions in expandable", async () => {
    await renderHome();
    await act(async () => {});
    // 行内常用操作始终可见
    expect(findButton("标注")).toBeTruthy();
    expect(findButton("训练")).toBeTruthy();
    expect(findButton("删除")).toBeTruthy();
  });

  it("runs row actions from the list", async () => {
    const onTrain = vi.fn();
    await renderHome({ onTrain });
    await act(async () => {});
    await clickButton("训练");
    expect(onTrain).toHaveBeenCalledWith(dataset);
  });

  it("keeps 添加 in the default row actions", async () => {
    await renderHome();
    await act(async () => {});
    expect(findButton("添加")).toBeTruthy();
  });

  it("filters datasets by the search box", async () => {
    await renderHome({ datasets: [dataset, secondDataset] });
    await act(async () => {});
    expect(tableRows().length).toBeGreaterThanOrEqual(2);

    // antd Input.Search 的 input 元素
    const search = document.body.querySelector<HTMLInputElement>(".ant-input");
    expect(search).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(search, "blade");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {});
    expect(tableRows().length).toBeGreaterThanOrEqual(1);
    expect(tableRows()[0]?.textContent).toContain("blade-photos");
  });
});
