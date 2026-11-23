// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageItem } from "../types";

const listImagesPage = vi.hoisted(() => vi.fn());
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api, listImagesPage } };
});

import { useImagePage, type ImagePageResult } from "./useImagePage";

function image(id: string): ImageItem {
  return { id, dataset_id: "ds-1", file_name: `${id}.png`, width: 10, height: 10, split: "train", status: "unannotated", file_url: `/api/images/${id}/file`, created_at: "", updated_at: "" };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let latest: ImagePageResult | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeProps = { currentImageId: string; pageSize: number; split?: string; status?: string; version?: number };

function Probe(props: ProbeProps) {
  latest = useImagePage({
    datasetId: "ds-1",
    currentImageId: props.currentImageId,
    pageSize: props.pageSize,
    split: (props.split ?? "") as never,
    status: (props.status ?? "") as never,
    version: props.version,
  });
  const text = [
    latest.items.map((item) => item.file_name).join(","),
    `page ${latest.page}/${latest.pageCount}`,
    `total ${latest.total}`,
    latest.loading ? "loading" : latest.error ? `error:${latest.error}` : "ready",
  ].join(" | ");
  return <div>{text}</div>;
}

const text = () => container?.textContent ?? "";
const calls = () => listImagesPage.mock.calls.map((call) => call.slice(1));

/** 等待挂起的状态更新与请求回调跑完 */
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

async function render(props: ProbeProps) {
  await act(async () => { root?.render(<Probe {...props} />); });
  await settle();
}

async function rerender(props: ProbeProps) {
  await act(async () => { root?.render(<Probe {...props} />); });
  await settle();
}

async function click(fn: () => void) {
  await act(async () => { fn(); });
  await settle();
}

/** 按 offset/limit/anchor 切片的内存版接口,只用于断言 hook 发了什么请求 */
function serve(all: ImageItem[]) {
  listImagesPage.mockImplementation(async (_datasetId: string, offset: number, limit: number, filters: { split?: string; status?: string; anchor?: string }) => {
    const rows = all.filter((item) => (!filters?.split || item.split === filters.split) && (!filters?.status || item.status === filters.status));
    let resolved = offset;
    if (filters?.anchor) {
      const index = rows.findIndex((item) => item.id === filters.anchor);
      if (index >= 0) resolved = Math.floor(index / limit) * limit;
    }
    return { items: rows.slice(resolved, resolved + limit), total: rows.length, offset: resolved };
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  latest = undefined;
  listImagesPage.mockReset();
});

afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("useImagePage", () => {
  it("只请求一页,并按当前图片定位", async () => {
    const all = Array.from({ length: 23 }, (_, index) => image(`img-${index}`));
    serve(all);
    await render({ currentImageId: "img-13", pageSize: 5 });

    expect(calls()).toEqual([[0, 5, { split: "", status: "", anchor: "img-13" }]]);
    // 第 14 张(下标 13)在每页 5 张的第 3 页
    expect(text()).toBe("img-10.png,img-11.png,img-12.png,img-13.png,img-14.png | page 3/5 | total 23 | ready");
  });

  it("点页码后按 offset 取那一页", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-13", pageSize: 5 });
    await click(() => latest?.goToPage(5));

    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toEqual([20, 5, { split: "", status: "", anchor: undefined }]);
    expect(text()).toContain("img-20.png,img-21.png,img-22.png | page 5/5");
  });

  it("当前图片就在可见页时,切换到它不重复请求", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-13", pageSize: 5 });
    await rerender({ currentImageId: "img-11", pageSize: 5 });

    expect(listImagesPage).toHaveBeenCalledTimes(1);
  });

  it("当前图片跳到可见页之外时,重新定位到它所在的页", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-13", pageSize: 5 });
    await rerender({ currentImageId: "img-1", pageSize: 5 });

    expect(calls()[1]).toEqual([0, 5, { split: "", status: "", anchor: "img-1" }]);
    expect(text()).toContain("img-0.png,img-1.png,img-2.png,img-3.png,img-4.png | page 1/5");
  });

  it("用户翻到别的页后,列表刷新仍停留在用户选的页", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-13", pageSize: 5, version: 0 });
    await click(() => latest?.goToPage(5));
    await rerender({ currentImageId: "img-13", pageSize: 5, version: 1 });

    expect(calls()[2]).toEqual([20, 5, { split: "", status: "", anchor: undefined }]);
    expect(text()).toContain("page 5/5");
  });

  it("筛选条件带上服务端,并回到当前图片在筛选结果里所在的页", async () => {
    const all = Array.from({ length: 12 }, (_, index) => image(`img-${index}`));
    all[10].split = "val";
    all[11].split = "val";
    serve(all);
    await render({ currentImageId: "img-1", pageSize: 1 });
    await rerender({ currentImageId: "img-1", pageSize: 1, split: "val" });

    // 当前图片不在 val 里:沿用第 1 页,并显示筛选后的总数
    expect(calls()[1]).toEqual([0, 1, { split: "val", status: "", anchor: "img-1" }]);
    expect(text()).toBe("img-10.png | page 1/2 | total 2 | ready");
  });

  it("每页条数变化后按新的页大小重新定位", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-13", pageSize: 5 });
    await rerender({ currentImageId: "img-13", pageSize: 10 });

    expect(calls()[1]).toEqual([0, 10, { split: "", status: "", anchor: "img-13" }]);
    expect(text()).toContain("page 2/3");
  });

  it("列表刷新时保留已显示的内容,不清空列表", async () => {
    serve(Array.from({ length: 8 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-3", pageSize: 20, version: 0 });
    let finish!: (value: unknown) => void;
    listImagesPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
    await act(async () => { root?.render(<Probe currentImageId="img-3" pageSize={20} version={1} />); });

    expect(latest?.loading).toBe(true);
    expect(latest?.items).toHaveLength(8);
    await act(async () => { finish({ items: [image("img-3")], total: 1, offset: 0 }); });
    expect(text()).toContain("img-3.png | page 1/1 | total 1 | ready");
  });

  it("迟到的旧响应不会覆盖较新的结果", async () => {
    const pending: Array<(value: unknown) => void> = [];
    listImagesPage.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }) as never);
    await render({ currentImageId: "img-1", pageSize: 5 });
    await rerender({ currentImageId: "img-99", pageSize: 5 });

    // 先返回新图片的结果,再返回旧图片的结果
    await act(async () => { pending[1]({ items: [image("new")], total: 1, offset: 0 }); });
    await act(async () => { pending[0]({ items: [image("stale")], total: 1, offset: 0 }); });
    expect(text()).toContain("new.png");
    expect(text()).not.toContain("stale");
  });

  it("翻页的加载间隙沿用旧总数,不会短暂归零", async () => {
    serve(Array.from({ length: 23 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-0", pageSize: 5 });
    let finish!: (value: unknown) => void;
    listImagesPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
    await click(() => latest?.goToPage(4));

    // 第 4 页的请求还挂着:总数仍是 23,分页器不会因 total=0 被卸掉
    expect(latest?.loading).toBe(true);
    expect(latest?.total).toBe(23);
    expect(latest?.pageCount).toBe(5);
    await act(async () => { finish({ items: [image("img-15")], total: 23, offset: 15 }); });
    expect(text()).toContain("img-15.png | page 4/5 | total 23 | ready");
  });

  it("当前页越界时退回到最后一页", async () => {
    listImagesPage.mockImplementation(async (_datasetId: string, offset: number, limit: number) =>
      offset >= 7 ? { items: [], total: 7, offset } : { items: [image(`img-${offset}`)], total: 7, offset });
    await render({ currentImageId: "img-0", pageSize: 5 });
    await click(() => latest?.goToPage(3)); // 下标 10 已超出 total 7

    expect(calls()[calls().length - 1]).toEqual([5, 5, { split: "", status: "", anchor: undefined }]);
    expect(text()).toContain("img-5.png | page 2/2 | total 7 | ready");
  });

  it("请求失败时报告错误,不再处于加载中", async () => {
    listImagesPage.mockRejectedValueOnce(new Error("网络异常"));
    await render({ currentImageId: "img-1", pageSize: 5 });

    expect(text()).toBe(" | page 1/1 | total 0 | error:网络异常");
  });

  it("goToPage 会被限制在有效页码内", async () => {
    serve(Array.from({ length: 12 }, (_, index) => image(`img-${index}`)));
    await render({ currentImageId: "img-0", pageSize: 5 });
    await click(() => latest?.goToPage(99));
    expect(calls()[1]?.[0]).toBe(10);
    await click(() => latest?.goToPage(-3));
    expect(calls()[2]?.[0]).toBe(0);
  });
});
