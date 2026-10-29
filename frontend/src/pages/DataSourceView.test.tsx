// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceView } from "./DataSourceView";
import type { SourceImage } from "../types";

vi.mock("../api/client", () => {
  const dataset = { id: "sd-1", name: "路口白天", description: null, image_count: 3, tag_count: 2, created_at: "", updated_at: "" };
  const tagA = { id: "stag-a", name: "白天", color: "#3157d5", values: ["晴", "阴"], image_count: 0 };
  const tagB = { id: "stag-b", name: "夜间", color: "#22c55e", image_count: 0 };
  const image = (id: string, name: string): SourceImage => ({
    id, file_name: name, width: 60, height: 40, size_bytes: 1024, source_type: "upload", tags: [],
    file_url: `/api/source-datasets/sd-1/images/${id}/file`,
    thumbnail_url: `/api/source-datasets/sd-1/images/${id}/thumbnail`,
    created_at: "2026-10-18T07:02:42Z",
  });
  const ftpEntries: Record<string, { name: string; path: string; is_dir: boolean; size: number | null; modified: string | null }[]> = {
    "/": [
      { name: "cam1", path: "/cam1", is_dir: true, size: null, modified: null },
      { name: "a.png", path: "/a.png", is_dir: false, size: 2048, modified: null },
      { name: "b.jpg", path: "/b.jpg", is_dir: false, size: 4096, modified: null },
      { name: "note.txt", path: "/note.txt", is_dir: false, size: 10, modified: null },
    ],
    "/cam1": [
      { name: "d.png", path: "/cam1/d.png", is_dir: false, size: 1024, modified: null },
    ],
  };
  return {
    api: {
      listSourceDatasets: vi.fn().mockResolvedValue([dataset]),
      listMaterialTypes: vi.fn().mockResolvedValue([]),
      createSourceDataset: vi.fn(),
      updateSourceDataset: vi.fn(),
      deleteSourceDataset: vi.fn(),
      syncTagTemplates: vi.fn().mockResolvedValue([]),
    listSourceTags: vi.fn().mockResolvedValue([tagA, tagB]),
      createSourceTag: vi.fn(),
      updateSourceTag: vi.fn(),
      deleteSourceTag: vi.fn(),
      listSourceImages: vi.fn().mockResolvedValue({ total: 3, offset: 0, limit: 60, items: [image("simg-1", "one.png"), image("simg-2", "two.png"), image("simg-3", "three.png")] }),
      uploadSourceImages: vi.fn().mockResolvedValue({ imported: 2, invalid: 0 }),
      batchUpdateSourceImageTags: vi.fn().mockResolvedValue({ updated: 2 }),
      updateSourceImage: vi.fn(),
      deleteSourceImage: vi.fn(),
      listFtp: vi.fn().mockImplementation((path: string) => Promise.resolve({ path, entries: ftpEntries[path] ?? [] })),
      syncSourceFromFtp: vi.fn().mockResolvedValue({ synced: 2, skipped: 0 }),
    },
    apiUrl: (path: string) => path,
  };
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

const openDetail = async () => {
  await act(async () => { root?.render(<DataSourceView />); });
  await act(async () => {});
  const open = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "打开");
  await act(async () => { open?.click(); });
  await act(async () => {});
};

const clickButton = async (label: string | RegExp) => {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) =>
    typeof label === "string" ? (item.textContent ?? "").includes(label) : label.test(item.textContent ?? "")
  );
  expect(button, `button ${String(label)} should exist`).toBeDefined();
  await act(async () => { button?.click(); });
  await act(async () => {});
};

describe("DataSourceView batch tags and upload tags", () => {
  it("batch applies a tag to multiple selected images", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    expect(container?.querySelector(".source-image-meta small")?.textContent).toMatch(/导入 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);

    await clickButton("批量选择");
    await clickButton("one.png");
    await clickButton("two.png");
    expect(container?.querySelector(".source-image-card.selected")?.textContent).toContain("one.png");

    await clickButton("+ 白天");
    await clickButton("关联 1 个标签");
    expect(api.batchUpdateSourceImageTags).toHaveBeenCalledWith("sd-1", ["simg-1", "simg-2"], ["stag-a"], false, { "stag-a": "晴" });

    await clickButton("取消关联");
    await clickButton("－ 白天");
    await clickButton("取消 1 个标签");
    expect(api.batchUpdateSourceImageTags).toHaveBeenLastCalledWith("sd-1", ["simg-1", "simg-2"], ["stag-a"], true, {});

    await clickButton("退出选择");
    expect(container?.querySelector(".source-image-card.selected")).toBeNull();
  });

  it("uploads files with the tags chosen in the upload dialog", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    await clickButton("上传图片");
    const chip = Array.from(container?.querySelectorAll<HTMLButtonElement>(".source-tag-chip > button") ?? []).find((item) => item.textContent === "夜间");
    await act(async () => { chip?.click(); });

    const fileInput = container?.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeDefined();
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [new File(["x"], "new.png", { type: "image/png" })] });
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});

    await clickButton("开始上传");
    expect(api.uploadSourceImages).toHaveBeenCalledWith("sd-1", [expect.any(File)], ["stag-b"], {});
  });
});

describe("DataSourceView tag filter", () => {
  it("filters images by multiple selected tags", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    const chip = (name: string) =>
      Array.from(container?.querySelectorAll<HTMLButtonElement>(".source-tag-bar .source-tag-chip > button, .source-tag-bar > button.source-tag-chip") ?? [])
        .find((item) => item.textContent?.startsWith(name));
    await act(async () => { chip("白天")?.click(); });
    await act(async () => {});
    await act(async () => { chip("夜间")?.click(); });
    await act(async () => {});

    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { offset: 0, limit: 60, tagIds: ["stag-a", "stag-b"], tagValues: {}, tagMatch: "all" });

    const anyButton = Array.from(container?.querySelectorAll<HTMLButtonElement>(".tag-match-switch button") ?? []).find((item) => item.textContent === "或");
    expect(anyButton).toBeDefined();
    await act(async () => { anyButton?.click(); });
    await act(async () => {});
    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { offset: 0, limit: 60, tagIds: ["stag-a", "stag-b"], tagValues: {}, tagMatch: "any" });

    await clickButton("全部");
    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { offset: 0, limit: 60, tagIds: undefined, tagValues: {}, tagMatch: "any" });
  });

  it("refetches when the enum value filter changes on the first page", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    await clickButton("白天");
    const select = container?.querySelector<HTMLSelectElement>('select[aria-label="按白天取值筛选"]');
    expect(select).toBeDefined();
    await act(async () => {
      if (select) select.value = "晴";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});
    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { offset: 0, limit: 60, tagIds: ["stag-a"], tagValues: { "stag-a": "晴" }, tagMatch: "all" });
  });
});

describe("DataSourceView FTP picker", () => {
  it("syncs an entire folder from the browsed directory with tags", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    await clickButton("FTP 同步");
    await act(async () => {});
    const tagChip = Array.from(container?.querySelectorAll<HTMLButtonElement>(".ftp-picker-tags .source-tag-chip > button") ?? []).find((item) => item.textContent === "白天");
    await act(async () => { tagChip?.click(); });
    const folder = Array.from(container?.querySelectorAll<HTMLButtonElement>(".ftp-name.dir") ?? []).find((item) => item.textContent?.includes("cam1"));
    await act(async () => { folder?.click(); });
    await act(async () => {});

    await clickButton("同步整个文件夹");
    expect(api.syncSourceFromFtp).toHaveBeenCalledWith("sd-1", { path: "/cam1", recursive: true, tagIds: ["stag-a"], tagValues: { "stag-a": "晴" } }, expect.any(Function));
  });

  it("imports multiple selected files across folders", async () => {
    const { api } = await import("../api/client");
    await openDetail();

    await clickButton("FTP 同步");
    await act(async () => {});
    const checkboxFor = (name: string) =>
      Array.from(container?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])
        .find((item) => item.closest("tr")?.textContent?.includes(name));
    const rowFor = (name: string) =>
      Array.from(container?.querySelectorAll<HTMLTableRowElement>(".ftp-table tbody tr") ?? [])
        .find((item) => item.textContent?.includes(name));
    expect(checkboxFor("note.txt")?.disabled).toBe(true);
    await act(async () => { rowFor("a.png")?.click(); });
    await act(async () => { checkboxFor("b.jpg")?.click(); });

    const folder = Array.from(container?.querySelectorAll<HTMLButtonElement>(".ftp-name.dir") ?? []).find((item) => item.textContent?.includes("cam1"));
    await act(async () => { folder?.click(); });
    await act(async () => {});
    await act(async () => { checkboxFor("d.png")?.click(); });

    await clickButton(/导入所选 3 张/);
    expect(api.syncSourceFromFtp).toHaveBeenCalledWith("sd-1", { path: "/", recursive: false, filePaths: ["/a.png", "/b.jpg", "/cam1/d.png"], tagIds: [], tagValues: {} }, expect.any(Function));
  });
});
