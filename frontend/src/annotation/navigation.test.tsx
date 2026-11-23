// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageItem, ImageNeighbors } from "../types";

const mocks = vi.hoisted(() => ({ getImage: vi.fn(), listImagesPage: vi.fn(), imageNeighbors: vi.fn() }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

import { writeAnnotationCursor } from "./cursor";
import { pickEntryImage, pickReplacementImage, useImageNeighbors } from "./navigation";

function image(id: string, overrides: Partial<ImageItem> = {}): ImageItem {
  return { id, dataset_id: "ds-1", file_name: `${id}.png`, width: 10, height: 10, split: "train", status: "unannotated", file_url: `/api/images/${id}/file`, created_at: "", updated_at: "", ...overrides };
}

const neighborsOf = (previous: string | null, next: string | null, index = 1, total = 3): ImageNeighbors => ({
  previous: previous ? image(previous) : null,
  next: next ? image(next) : null,
  index,
  total,
});

const page = (items: ImageItem[]) => ({ items, total: items.length, offset: 0 });
const notFound = () => Promise.reject(new Error("404"));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("pickEntryImage", () => {
  it("回到上次标注到的图片", async () => {
    writeAnnotationCursor("ds-1", "img-9");
    mocks.getImage.mockResolvedValue(image("img-9"));

    expect((await pickEntryImage("ds-1"))?.id).toBe("img-9");
    expect(mocks.getImage).toHaveBeenCalledWith("ds-1", "img-9");
    expect(mocks.listImagesPage).not.toHaveBeenCalled();
  });

  it("游标对应的图片已被删除时,退回首张未标注", async () => {
    writeAnnotationCursor("ds-1", "img-gone");
    mocks.getImage.mockImplementation(notFound);
    mocks.listImagesPage.mockResolvedValueOnce(page([image("img-first-open", { status: "unannotated" })]));

    expect((await pickEntryImage("ds-1"))?.id).toBe("img-first-open");
    expect(mocks.listImagesPage).toHaveBeenCalledTimes(1);
    expect(mocks.listImagesPage).toHaveBeenCalledWith("ds-1", 0, 1, { status: "unannotated" });
  });

  it("没有游标时取首张未标注;全部已标注则取第一张", async () => {
    mocks.listImagesPage.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([image("img-first")]));
    expect((await pickEntryImage("ds-1"))?.id).toBe("img-first");
    expect(mocks.listImagesPage.mock.calls).toEqual([
      ["ds-1", 0, 1, { status: "unannotated" }],
      ["ds-1", 0, 1],
    ]);
  });

  it("数据集没有图片时返回 undefined", async () => {
    mocks.listImagesPage.mockResolvedValue(page([]));
    expect(await pickEntryImage("ds-1")).toBeUndefined();
  });

  it("游标只认本数据集", async () => {
    writeAnnotationCursor("ds-other", "img-other");
    mocks.listImagesPage.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([image("img-mine")]));
    mocks.getImage.mockResolvedValue(image("img-other"));

    expect((await pickEntryImage("ds-1"))?.id).toBe("img-mine");
    expect(mocks.getImage).not.toHaveBeenCalled();
  });
});

describe("pickReplacementImage", () => {
  it("优先打开被删图片的后一张", async () => {
    expect((await pickReplacementImage("ds-1", neighborsOf("img-0", "img-2"), ["img-1"]))?.id).toBe("img-2");
    expect(mocks.listImagesPage).not.toHaveBeenCalled();
  });

  it("后一张也被删时打开前一张", async () => {
    expect((await pickReplacementImage("ds-1", neighborsOf("img-0", "img-2"), ["img-1", "img-2"]))?.id).toBe("img-0");
  });

  it("前后都被删(或没有邻居信息)时取数据集第一张", async () => {
    mocks.listImagesPage.mockResolvedValue(page([image("img-first")]));
    expect((await pickReplacementImage("ds-1", neighborsOf("img-0", "img-2"), ["img-0", "img-1", "img-2"]))?.id).toBe("img-first");
    expect((await pickReplacementImage("ds-1", undefined, ["img-1"]))?.id).toBe("img-first");
    expect(mocks.listImagesPage).toHaveBeenCalledWith("ds-1", 0, 1);
  });

  it("数据集已空时返回 undefined", async () => {
    mocks.listImagesPage.mockResolvedValue(page([]));
    expect(await pickReplacementImage("ds-1", undefined, ["img-1"])).toBeUndefined();
  });
});

describe("useImageNeighbors", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let latest: ImageNeighbors | undefined;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = undefined;
  });
  afterEach(() => { act(() => root?.unmount()); container?.remove(); });

  function Probe({ imageId, version }: { imageId: string; version: number }) {
    latest = useImageNeighbors("ds-1", imageId, version);
    return <div>{latest ? `${latest.previous?.id ?? "-"}|${latest.next?.id ?? "-"}|${latest.index}/${latest.total}` : "loading"}</div>;
  }

  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  async function render(imageId: string, version = 0) {
    await act(async () => { root?.render(<Probe imageId={imageId} version={version} />); });
    await settle();
  }

  it("给出当前图片的前后邻居和位置", async () => {
    mocks.imageNeighbors.mockResolvedValue(neighborsOf("img-0", "img-2"));
    await render("img-1");

    expect(mocks.imageNeighbors).toHaveBeenCalledWith("ds-1", "img-1");
    expect(container?.textContent).toBe("img-0|img-2|1/3");
  });

  it("切换图片后、新结果到达前,不沿用上一张的邻居", async () => {
    mocks.imageNeighbors.mockResolvedValueOnce(neighborsOf("img-0", "img-2"));
    await render("img-1");
    let finish!: (value: ImageNeighbors) => void;
    mocks.imageNeighbors.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));

    await act(async () => { root?.render(<Probe imageId="img-2" version={0} />); });
    expect(latest).toBeUndefined();

    await act(async () => { finish(neighborsOf("img-1", null, 2, 3)); });
    expect(container?.textContent).toBe("img-1|-|2/3");
  });

  it("列表版本变化时重新拉取,刷新后仍显示当前图片的邻居", async () => {
    mocks.imageNeighbors.mockResolvedValue(neighborsOf("img-0", "img-2"));
    await render("img-1", 0);
    mocks.imageNeighbors.mockResolvedValue(neighborsOf(null, "img-2", 0, 3));
    await act(async () => { root?.render(<Probe imageId="img-1" version={1} />); });
    await settle();

    expect(mocks.imageNeighbors).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toBe("-|img-2|0/3");
  });

  it("请求失败时按没有上一张/下一张处理,不残留旧值", async () => {
    mocks.imageNeighbors.mockResolvedValueOnce(neighborsOf("img-0", "img-2"));
    await render("img-1", 0);
    mocks.imageNeighbors.mockRejectedValueOnce(new Error("boom"));
    await act(async () => { root?.render(<Probe imageId="img-1" version={1} />); });
    await settle();

    expect(latest).toBeUndefined();
  });

  it("迟到的旧图片响应不会覆盖当前图片的邻居", async () => {
    const pending: Array<(value: ImageNeighbors) => void> = [];
    mocks.imageNeighbors.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    await render("img-1");
    await act(async () => { root?.render(<Probe imageId="img-2" version={0} />); });

    await act(async () => { pending[1](neighborsOf("img-1", "img-3")); });
    await act(async () => { pending[0](neighborsOf("img-0", "img-2")); });
    expect(container?.textContent).toBe("img-1|img-3|1/3");
  });
});
