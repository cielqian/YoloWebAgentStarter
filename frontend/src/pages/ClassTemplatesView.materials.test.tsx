// @vitest-environment jsdom
// antd 组件在 jsdom 里需要的浏览器 API mock(引入 antd 的测试文件统一带上)

beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
    });
  }
  if (!window.ResizeObserver) {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: object }).ResizeObserver = ResizeObserverMock;
  }
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassTemplatesView } from "./ClassTemplatesView";
import { api } from "../api/client";
import type { MaterialType } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listClassTemplates: vi.fn().mockResolvedValue([]),
    listMaterialTypes: vi.fn(),
    createMaterialType: vi.fn(),
    updateMaterialType: vi.fn(),
    deleteMaterialType: vi.fn(),
  },
}));

const item: MaterialType = {
  id: "mt-1",
  name: "可见光图片",
  description: "白天拍摄",
  created_at: "2026-10-29T01:00:00Z",
  updated_at: "2026-10-29T01:00:00Z",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.mocked(api.listMaterialTypes).mockResolvedValue([item]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

async function renderMaterialsTab() {
  await act(async () => {
    root?.render(<ClassTemplatesView />);
  });
  await act(async () => {});
  const tab = Array.from(container!.querySelectorAll<HTMLElement>("[role='tab']")).find((el) => el.textContent === "素材类型");
  await act(async () => { tab?.click(); });
  await act(async () => {});
}

describe("素材类型页签(antd 试点)", () => {
  it("渲染表格数据与操作列", async () => {
    await renderMaterialsTab();
    expect(api.listMaterialTypes).toHaveBeenCalled();
    expect(container?.textContent).toContain("可见光图片");
    expect(container?.textContent).toContain("白天拍摄");
    expect(container?.textContent).toContain("编辑");
    expect(container?.textContent).toContain("删除");
  });

  it("新增弹窗提交调用创建接口", async () => {
    vi.mocked(api.createMaterialType).mockResolvedValue(item);
    await renderMaterialsTab();
    const trigger = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find((el) => el.textContent?.includes("新增素材类型"));
    await act(async () => { trigger?.click(); });
    await act(async () => {});
    const input = document.body.querySelector<HTMLInputElement>("input#name");
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "红外视频");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const ok = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ant-modal-footer button")).find((el) => el.classList.contains("ant-btn-primary"));
    await act(async () => { ok?.click(); });
    await act(async () => {});
    expect(api.createMaterialType).toHaveBeenCalledWith(expect.objectContaining({ name: "红外视频" }));
  });
});
