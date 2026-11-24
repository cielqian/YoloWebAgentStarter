// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
// antd 组件在 jsdom 里需要的浏览器 API mock
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
    });
  }
  if (!window.getComputedStyle.toString().includes('not-implemented')) {
    const orig = window.getComputedStyle.bind(window);
    (window as unknown as { getComputedStyle: typeof window.getComputedStyle }).getComputedStyle = (elt: Element, pseudoElt?: string | null) => {
      if (pseudoElt) return orig(elt) as CSSStyleDeclaration;
      return orig(elt);
    };
  }
  if (!window.ResizeObserver) {
    class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
    (window as unknown as { ResizeObserver: object }).ResizeObserver = ResizeObserverMock;
  }
});

import { AlgorithmTestView } from "./AlgorithmTestView";

vi.mock("../components/confirm", () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));

const dataset = {
  id: "tds-1",
  name: "塔筒裂缝-测试集",
  task_type: "detect" as const,
  source: "local" as const,
  version: "v1.2",
  purpose_tag: "regression" as const,
  status: "ready" as const,
  ftp_dir: null,
  notes: null,
  image_count: 3,
  class_count: 2,
  marked_count: 1,
  marked_percent: 33.3,
  created_at: "2026-11-24T08:00:00Z",
  updated_at: "2026-11-24T08:00:00Z",
};

const apiMocks = vi.hoisted(() => ({
  listTestDatasets: vi.fn(),
  createTestDataset: vi.fn(),
  createTestDatasetFromFtp: vi.fn(),
  cancelTestDatasetImport: vi.fn(),
  listFtp: vi.fn(),
  deleteTestDataset: vi.fn(),
  listTestClasses: vi.fn(),
  listTestImagesPage: vi.fn(),
  testImageNeighbors: vi.fn(),
  getTestAnnotations: vi.fn(),
  replaceTestAnnotations: vi.fn(),
  uploadTestImages: vi.fn(),
  deleteTestImage: vi.fn(),
  createTestClass: vi.fn(),
  importTestClasses: vi.fn(),
  deleteTestClass: vi.fn(),
  testImageUrl: vi.fn().mockReturnValue("/api/algorithm-test/images/timg-1/file"),
  testImageThumbnailUrl: vi.fn().mockReturnValue("/api/algorithm-test/images/timg-1/thumbnail"),
}));

vi.mock("../api/client", () => ({ api: apiMocks }));

// AnnotationView 内部的侧栏分页 hook 走 api.listTestImagesPage,已在上面 mock。

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listTestDatasets.mockResolvedValue([dataset]);
  apiMocks.listFtp.mockResolvedValue({ path: "/", entries: [
    { name: "2024Q3", path: "/2024Q3", is_dir: true, size: null, modified: null },
    { name: "data.zip", path: "/data.zip", is_dir: false, size: 2048, modified: null },
    { name: "note.txt", path: "/note.txt", is_dir: false, size: 10, modified: null },
  ] });
  apiMocks.testImageNeighbors.mockResolvedValue({ previous: null, next: null, index: 0, total: 1 });
  apiMocks.listTestClasses.mockResolvedValue([
    { id: "tcls-1", test_dataset_id: "tds-1", class_index: 0, name: "裂缝", color: "#22c55e", created_at: "", updated_at: "" },
    { id: "tcls-2", test_dataset_id: "tds-1", class_index: 1, name: "锈蚀", color: "#f97316", created_at: "", updated_at: "" },
  ]);
  apiMocks.listTestImagesPage.mockResolvedValue({ total: 1, offset: 0, items: [
    { id: "timg-1", test_dataset_id: "tds-1", file_name: "IMG_0428.jpg", width: 800, height: 600, status: "unmarked", point_id: null, ftp_path: null, created_at: "2026-11-24T08:00:00Z" },
  ] });
  apiMocks.getTestAnnotations.mockResolvedValue([]);
  apiMocks.testImageNeighbors.mockResolvedValue({ previous: null, next: null, index: 0, total: 1 });
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

function render(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<AlgorithmTestView {...props} />); });
}

const clickByText = (elements: NodeListOf<HTMLElement> | HTMLElement[], text: string) => {
  const candidates = Array.from(elements instanceof NodeList ? (elements as NodeListOf<HTMLElement>) : elements);
  const target = candidates.find((item) => item.textContent?.replace(/\s+/g, "") === text.replace(/\s+/g, ""))
    ?? candidates.find((item) => (item.textContent ?? "").replace(/\s+/g, "").includes(text.replace(/\s+/g, "")));
  if (!target) throw new Error(`button "${text}" not found; have: ${candidates.map((item) => item.textContent?.trim()).join(" | ")}`);
  act(() => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

describe("AlgorithmTestView 测试数据集管理", () => {
  it("渲染数据集列表与统计信息", async () => {
    render();
    await act(async () => {});
    expect(apiMocks.listTestDatasets).toHaveBeenCalled();
    expect(container!.textContent).toContain("算法测试 · 测试数据集");
    expect(container!.textContent).toContain("塔筒裂缝-测试集");
    expect(container!.textContent).toContain("回归基线");
    expect(container!.textContent).toContain("共 1 个测试数据集");
  });

  it("新建数据集提交表单调用 createTestDataset", async () => {
    apiMocks.createTestDataset.mockResolvedValue({ ...dataset, id: "tds-2", name: "新测试集", image_count: 0, class_count: 0, marked_count: 0, marked_percent: 0 });
    render();
    await act(async () => {});
    clickByText(container!.querySelectorAll("button"), "新建数据集");
    await act(async () => {});
    // antd Modal 挂在 body 的 portal 里,不在测试容器内
    const nameInput = document.body.querySelector("input[placeholder='例如：塔筒裂缝-测试集']") as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    await act(async () => {
      // React 受控输入需要走原生 value setter,否则表单状态不更新
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(nameInput!, "新测试集");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickByText(document.body.querySelectorAll("button"), "创 建");
    await act(async () => {});
    expect(apiMocks.createTestDataset).toHaveBeenCalledWith(expect.objectContaining({ name: "新测试集", task_type: "detect", purpose_tag: "regression" }));
  });

  it("进入在线标注:加载类别与图片,保存调用 replaceTestAnnotations 并上报 dirty", async () => {
    apiMocks.replaceTestAnnotations.mockResolvedValue([]);
    const onDirtyChange = vi.fn();
    render({ onDirtyChange });
    await act(async () => {});
    clickByText(container!.querySelectorAll("button"), "在线标注");
    await act(async () => {});
    expect(apiMocks.listTestClasses).toHaveBeenCalledWith("tds-1");
    expect(apiMocks.listTestImagesPage).toHaveBeenCalledWith("tds-1", 0, 1, { status: "unmarked" });
    expect(apiMocks.getTestAnnotations).toHaveBeenCalledWith("tds-1", "timg-1");
    expect(container!.textContent).toContain("预期结果标记");
    expect(container!.textContent).toContain("IMG_0428.jpg");
    expect(container!.textContent).toContain("未标记");
    // dirty 状态上报给 App 级导航守卫
    expect(onDirtyChange).toHaveBeenCalledWith(false);
    clickByText(container!.querySelectorAll("button"), "保存标注");
    await act(async () => {});
    expect(apiMocks.replaceTestAnnotations).toHaveBeenCalledWith("tds-1", "timg-1", expect.any(Array));
  });

  it("没有未标记图片时回退到第一张", async () => {
    apiMocks.listTestImagesPage.mockImplementation(async (_id: string, _offset: number, _limit: number, filters: { status?: string } | undefined = {}) =>
      filters?.status === "unmarked" ? { total: 0, offset: 0, items: [] } : { total: 1, offset: 0, items: [
        { id: "timg-9", test_dataset_id: "tds-1", file_name: "IMG_0430.jpg", width: 800, height: 600, status: "marked", point_id: null, ftp_path: null, created_at: "2026-11-24T08:00:00Z" },
      ] });
    render();
    await act(async () => {});
    clickByText(container!.querySelectorAll("button"), "在线标注");
    await act(async () => {});
    expect(apiMocks.getTestAnnotations).toHaveBeenCalledWith("tds-1", "timg-9");
    expect(container!.textContent).toContain("IMG_0430.jpg");
  });

  it("FTP 同步:浏览目录选 zip 提交调用 createTestDatasetFromFtp", async () => {
    apiMocks.createTestDatasetFromFtp.mockResolvedValue({ ...dataset, id: "tds-3", source: "ftp", import_state: "importing" });
    render();
    await act(async () => {});
    clickByText(container!.querySelectorAll("button"), "FTP 同步");
    await act(async () => {});
    expect(apiMocks.listFtp).toHaveBeenCalledWith("/");
    // 弹窗在 body portal:填名称、点选 zip
    const nameInput = document.body.querySelector("input[placeholder='例如：机舱锈蚀-分类测试集']") as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(nameInput!, "锈蚀FTP集");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickByText(document.body.querySelectorAll("button"), "data.zip");
    await act(async () => {});
    clickByText(document.body.querySelectorAll("button"), "开始同步");
    await act(async () => {});
    expect(apiMocks.createTestDatasetFromFtp).toHaveBeenCalledWith(expect.objectContaining({ name: "锈蚀FTP集", task_type: "detect", path: "/data.zip", source: "zip" }));
  });

  it("导入中的数据集显示进度并可停止", async () => {
    apiMocks.listTestDatasets.mockResolvedValue([{ ...dataset, import_state: "importing", import_progress: 62.5 }]);
    apiMocks.cancelTestDatasetImport.mockResolvedValue({ ...dataset, import_state: "stopped" });
    render();
    await act(async () => {});
    expect(container!.textContent).toContain("63%");
    clickByText(container!.querySelectorAll("button"), "停止导入");
    await act(async () => {});
    expect(apiMocks.cancelTestDatasetImport).toHaveBeenCalledWith("tds-1");
  });
});
