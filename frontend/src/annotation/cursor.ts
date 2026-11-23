/** 标注断点续作:按数据集记录最后标注到的图片 id,重新进入时自动定位。 */
const ANNOTATION_CURSOR_PREFIX = "ywa.annotation.cursor.";

export const readAnnotationCursor = (datasetId: string): string | null => {
  try { return localStorage.getItem(ANNOTATION_CURSOR_PREFIX + datasetId); } catch { return null; }
};

export const writeAnnotationCursor = (datasetId: string, imageId: string) => {
  try { localStorage.setItem(ANNOTATION_CURSOR_PREFIX + datasetId, imageId); } catch { /* 隐私模式等场景 localStorage 不可用,静默降级 */ }
};
