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
  id: "ds-1", name: "road-signs", description: null, task_type: "detect",
  image_count: 12, annotated_image_count: 0, class_count: 3, created_at: "", updated_at: "",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("DatasetHome delete flow", () => {
  it("renders delete button in row with Popconfirm protection", async () => {
    const onDelete = vi.fn();
    await act(async () => {
      root?.render(<DatasetHome datasets={[dataset]} busy={false} onCreate={vi.fn()} onClone={vi.fn()} onImport={vi.fn()}
        onFtpImport={vi.fn()} onCancelImport={vi.fn()} onMergeYolo={vi.fn()} onMergeYoloFromFtp={vi.fn()}
        onQuality={vi.fn()} onContinueAnnotation={vi.fn()} onUpload={vi.fn()} onTrain={vi.fn()}
        onDuplicates={vi.fn()} onSourceSync={vi.fn()} onDelete={onDelete} />);
    });
    await act(async () => {});

    // 删除按钮存在于操作列
    const deleteBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => (el.textContent ?? "").includes("删除"));
    expect(deleteBtn, "删除 button should exist").toBeDefined();

    // 点击删除按钮不会直接调用 onDelete(有 Popconfirm 保护)
    await act(async () => { deleteBtn?.click(); });
    await act(async () => {});
    expect(onDelete).not.toHaveBeenCalled();
  });
});
