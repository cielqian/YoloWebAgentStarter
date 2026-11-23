import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ImageItem, SplitName } from "../types";

export type ImageStatusFilter = "" | "annotated" | "unannotated";

/** 当前要取哪一页:按当前图片定位(默认),或按用户点选的页。 */
type Query = { kind: "anchor"; imageId: string } | { kind: "offset"; offset: number };

type PageState = {
  /** 这份结果对应的查询;与当前查询不一致时视为尚未加载 */
  key: string;
  status: "loading" | "ready" | "error";
  items: ImageItem[];
  total: number;
  offset: number;
  error: string;
};

export interface ImagePageResult {
  /** 当前页的图片 */
  items: ImageItem[];
  /** 筛选后的总数 */
  total: number;
  /** 当前页码,从 1 计 */
  page: number;
  pageCount: number;
  loading: boolean;
  error: string;
  goToPage: (page: number) => void;
}

interface Params {
  datasetId: string;
  /** 当前正在标注的图片:侧栏始终显示它所在的那一页,直到用户自己翻页 */
  currentImageId: string;
  pageSize: number;
  split: SplitName | "";
  status: ImageStatusFilter;
  /** 外部通知图片列表发生了变化(上传/删除/保存/同步):重新拉取当前页 */
  version?: number;
}

/**
 * 服务端分页的图片列表:每次只请求侧栏正在显示的那一页,筛选和"定位到某张图"都在服务端完成。
 *
 * 取页规则:
 * - 默认按当前图片定位(anchor),所以当前图片总在可见页里;
 * - 用户点页码后按 offset 取该页,当前图片变化时若跳出了可见页则重新按当前图片定位;
 * - 筛选或每页条数变化时重新按当前图片定位。
 * 迟到的旧请求会被丢弃,不会覆盖较新的结果;同一筛选下翻页时总数沿用最近一次
 * 成功的值,分页器不会在加载间隙因 total 归零而消失。
 */
export function useImagePage({ datasetId, currentImageId, pageSize, split, status, version = 0 }: Params): ImagePageResult {
  const [query, setQuery] = useState<Query>({ kind: "anchor", imageId: currentImageId });
  const [state, setState] = useState<PageState>({ key: "", status: "loading", items: [], total: 0, offset: 0, error: "" });
  const requestSeq = useRef(0);
  // 同一筛选下最近一次成功取到的总数:翻页/刷新的加载间隙沿用它,
  // 避免总数短暂归零把分页器(hideOnSinglePage)整个卸掉重建。
  const lastTotalRef = useRef<{ key: string; total: number }>({ key: "", total: 0 });

  const filterKey = `${datasetId}|${split}|${status}|${pageSize}`;
  const lastFilterKey = useRef(filterKey);

  // 数据集、筛选或每页条数变化:回到当前图片所在的那一页
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setQuery({ kind: "anchor", imageId: currentImageId });
  }, [filterKey, currentImageId]);

  const queryKey = query.kind === "anchor" ? `a:${query.imageId}` : `o:${query.offset}`;
  const key = `${filterKey}|${queryKey}`;
  const view = state.key === key ? state : undefined;
  const items = view?.items ?? [];

  // 当前图片跳出了已显示的这一页(例如键盘翻到了别的页上的图片):定位到它所在的页。
  // items 用读取最新值的 ref:它经常变化,不该进依赖,否则每次列表更新都会重跑。
  const itemsRef = useRef<ImageItem[]>([]);
  itemsRef.current = items;
  useEffect(() => {
    if (itemsRef.current.some((item) => item.id === currentImageId)) return;
    setQuery((prev) => (prev.kind === "anchor" && prev.imageId === currentImageId ? prev : { kind: "anchor", imageId: currentImageId }));
  }, [currentImageId]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setState((prev) => {
      // 同一页刷新时保留已显示的内容,避免列表闪成空白
      const keep = prev.key === key;
      return { key, status: "loading", items: keep ? prev.items : [], total: keep ? prev.total : 0, offset: keep ? prev.offset : query.kind === "offset" ? query.offset : 0, error: "" };
    });
    api
      .listImagesPage(datasetId, query.kind === "offset" ? query.offset : 0, pageSize, { split, status, anchor: query.kind === "anchor" ? query.imageId : undefined })
      .then(
        (page) => {
          if (seq !== requestSeq.current) return;
          // 列表变短后这一页可能已经越界(例如批量删除之后):退回到最后一页
          if (!page.items.length && page.total > 0 && query.kind === "offset" && query.offset >= page.total) {
            setQuery({ kind: "offset", offset: Math.floor((page.total - 1) / pageSize) * pageSize });
            return;
          }
          setState({ key, status: "ready", items: page.items, total: page.total, offset: page.offset, error: "" });
          lastTotalRef.current = { key: filterKey, total: page.total };
        },
        (reason: unknown) => {
          if (seq !== requestSeq.current) return;
          setState({ key, status: "error", items: [], total: 0, offset: 0, error: reason instanceof Error ? reason.message : "加载图片列表失败" });
        },
      );
    return () => { requestSeq.current += 1; };
  }, [key, datasetId, query, pageSize, split, status, version]);

  // 未就绪(加载中/出错)时沿用同一筛选下的旧总数;筛选或每页条数变了才回到 0
  const total = view?.status === "ready" || lastTotalRef.current.key !== filterKey ? view?.total ?? 0 : lastTotalRef.current.total;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.floor((view?.offset ?? (query.kind === "offset" ? query.offset : 0)) / pageSize) + 1;

  const goToPage = useCallback((next: number) => {
    setQuery({ kind: "offset", offset: (Math.min(Math.max(next, 1), pageCount) - 1) * pageSize });
  }, [pageSize, pageCount]);

  return { items, total, page, pageCount, loading: !view || view.status === "loading", error: view?.status === "error" ? view.error : "", goToPage };
}
