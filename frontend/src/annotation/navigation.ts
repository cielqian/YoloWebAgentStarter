import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ImageItem, ImageNeighbors } from "../types";
import { readAnnotationCursor } from "./cursor";

/**
 * 当前图片在数据集整体顺序下的前后邻居,供「上一张 / 下一张」使用。
 * 顺序不随侧栏的 split/状态筛选变化;列表发生变化时(version 变化)重新拉取。
 * 图片或数据集切换后、新结果到达前返回 undefined,导航按钮此时应禁用。
 */
export function useImageNeighbors(datasetId: string | undefined, imageId: string | undefined, version: number): ImageNeighbors | undefined {
  const [state, setState] = useState<{ datasetId: string; imageId: string; neighbors?: ImageNeighbors }>();

  useEffect(() => {
    if (!datasetId || !imageId) return;
    let cancelled = false;
    // 取不到邻居时按"没有上一张/下一张"处理:打开图片本身不应因此失败。
    api.imageNeighbors(datasetId, imageId).then(
      (neighbors) => { if (!cancelled) setState({ datasetId, imageId, neighbors }); },
      () => { if (!cancelled) setState({ datasetId, imageId, neighbors: undefined }); },
    );
    return () => { cancelled = true; };
  }, [datasetId, imageId, version]);

  if (!datasetId || !imageId || state?.datasetId !== datasetId || state.imageId !== imageId) return undefined;
  return state.neighbors;
}

/**
 * 进入标注页时先打开哪张图片:
 * 1. 上次标注到的那张(断点游标);游标对应的图片已被删除则跳过;
 * 2. 首张未标注的图片;
 * 3. 数据集的第一张。数据集没有图片时返回 undefined。
 */
export async function pickEntryImage(datasetId: string): Promise<ImageItem | undefined> {
  const savedId = readAnnotationCursor(datasetId);
  if (savedId) {
    const saved = await api.getImage(datasetId, savedId).catch(() => undefined);
    if (saved) return saved;
  }
  const firstUnannotated = await api.listImagesPage(datasetId, 0, 1, { status: "unannotated" });
  if (firstUnannotated.items[0]) return firstUnannotated.items[0];
  return (await api.listImagesPage(datasetId, 0, 1)).items[0];
}

/**
 * 当前图片被删除后打开哪张:优先它后面那张,其次前面那张(两者都未被这次删除),
 * 都没有就取数据集的第一张;数据集已空则返回 undefined。
 */
export async function pickReplacementImage(
  datasetId: string,
  neighbors: ImageNeighbors | undefined,
  deletedIds: string[],
): Promise<ImageItem | undefined> {
  const alive = (image: ImageItem | null | undefined): image is ImageItem => image != null && !deletedIds.includes(image.id);
  const nearby = [neighbors?.next, neighbors?.previous].find(alive);
  if (nearby) return nearby;
  return (await api.listImagesPage(datasetId, 0, 1)).items[0];
}
