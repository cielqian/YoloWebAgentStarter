// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationCanvas } from "./AnnotationCanvas";
import type { Annotation, ClassLabel, ImageItem } from "../types";

vi.mock("react-konva", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    // Konva 事件形如 { evt: NativeEvent, target: Node }，这里把 DOM 合成事件包装成同构形状
    Stage: ({ children, ...props }: any) => {
      const forwarded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        forwarded[key] = key.startsWith("on") && typeof value === "function"
          ? (event: any) => value({ ...event, evt: event.nativeEvent ?? {}, target: event.target })
          : value;
      }
      return <div data-testid="stage" {...(forwarded as any)}>{children}</div>;
    },
    Layer: ({ children }: any) => <div>{children}</div>,
    Image: () => <div data-testid="image" />,
    Circle: ({ onDragEnd, onDragMove, onDblClick }: any) => {
      const drag = onDragEnd ?? onDragMove;
      return (
        <div>
          {drag && <button aria-label="拖动顶点" onClick={() => drag({ target: { x: () => 30, y: () => 40 } })}></button>}
          {onDblClick && <button aria-label="删除顶点" onClick={onDblClick}></button>}
        </div>
      );
    },
    Line: ({ onDblClick }: any) => (
      <div data-testid="line">
        {onDblClick && <button aria-label="双击边线" onClick={() => onDblClick({ target: { getRelativePointerPosition: () => ({ x: 30, y: 15 }) }, cancelBubble: false })}></button>}
      </div>
    ),
    Rect: forwardRef((_props: any, ref) => {
      const { draggable, onClick, onTransformEnd } = _props;
      useImperativeHandle(ref, () => null);
      return <div>
        {draggable && <button aria-label="选择 OBB" onClick={onClick}>OBB</button>}
        {onTransformEnd && <button aria-label="旋转 OBB" onClick={() => onTransformEnd({ target: transformTarget() })}>变换</button>}
      </div>;
    }),
    Transformer: forwardRef(({ rotateEnabled }: any, ref) => {
      useImperativeHandle(ref, () => ({ nodes: () => undefined, getLayer: () => ({ batchDraw: () => undefined }) }));
      return <div data-testid="obb-transformer" data-rotate-enabled={String(rotateEnabled)} />;
    }),
  };
});

function transformTarget() {
  return {
    x: () => 50,
    y: () => 40,
    width: () => 40,
    height: () => 20,
    rotation: () => 45,
    scaleX: (value?: number) => value === undefined ? 1.5 : undefined,
    scaleY: (value?: number) => value === undefined ? 2 : undefined,
  };
}

const image: ImageItem = {
  id: "img-1",
  dataset_id: "ds-1",
  file_name: "vehicle.png",
  width: 100,
  height: 80,
  split: "train",
  status: "annotated",
  file_url: "/api/images/img-1/file",
  created_at: "",
  updated_at: "",
};

const classes: ClassLabel[] = [{ id: "cls-1", dataset_id: "ds-1", class_index: 0, name: "vehicle", color: "#22c55e", created_at: "", updated_at: "" }];

const annotation: Annotation = {
  id: "ann-1",
  image_id: image.id,
  dataset_id: image.dataset_id,
  class_id: classes[0].id,
  class_index: 0,
  label: "vehicle",
  color: classes[0].color,
  type: "obb",
  bbox: null,
  polygon: null,
  obb: { cx: 45, cy: 35, width: 30, height: 20, angle: 20 },
  source: "manual",
  created_at: "",
  updated_at: "",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalImage = window.Image;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  class ReadyImage {
    onload: (() => void) | null = null;
    set src(_value: string) { this.onload?.(); }
  }
  Object.defineProperty(window, "Image", { configurable: true, writable: true, value: ReadyImage });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  Object.defineProperty(window, "Image", { configurable: true, writable: true, value: originalImage });
});

describe("AnnotationCanvas OBB interactions", () => {
  it("selects an existing OBB, applies a transform and angle edit, then removes it", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" taskType="obb" onChange={onChange} />);
    });

    const select = container?.querySelector<HTMLButtonElement>("[aria-label='选择 OBB']");
    expect(select).toBeTruthy();
    act(() => select?.click());
    expect(container?.textContent).toContain("已选中 OBB");
    expect(container?.querySelector("[data-testid='obb-transformer']")?.getAttribute("data-rotate-enabled")).toBe("true");

    const transform = container?.querySelector<HTMLButtonElement>("[aria-label='旋转 OBB']");
    act(() => transform?.click());
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ obb: { cx: 50, cy: 40, width: 60, height: 40, angle: 45 } }),
    ]);

    const angle = container?.querySelector<HTMLInputElement>("[aria-label='OBB angle']");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(angle, "30");
      angle?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ obb: expect.objectContaining({ angle: 30 }) }),
    ]);

    const remove = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "删除所选 OBB");
    act(() => remove?.click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("does not cancel a normal drag when pointerup precedes mouseup", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[]} activeClassId="cls-1" taskType="detect" onChange={onChange} />);
    });

    const stage = container?.querySelector<HTMLDivElement>("[data-testid='stage']") as (HTMLDivElement & { getStage?: () => unknown; getClassName?: () => string; getPointerPosition?: () => { x: number; y: number } }) | null;
    expect(stage).toBeTruthy();
    let position = { x: 10, y: 10 };
    stage!.getStage = () => stage;
    stage!.getClassName = () => "Stage";
    stage!.getPointerPosition = () => position;

    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    position = { x: 60, y: 50 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    act(() => window.dispatchEvent(new Event("pointerup", { bubbles: true })));
    act(() => stage?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ class_id: "cls-1", type: "bbox", bbox: { x: 10, y: 10, width: 50, height: 40 }, source: "manual" })]);
  });

  it("clears every local draft after confirmation", async () => {
    const onChange = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" taskType="obb" onChange={onChange} />);
    });

    const clear = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "清空全部草稿");
    act(() => clear?.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([]);
    confirm.mockRestore();
  });

  it("blocks drawing until a class is selected", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={[]} annotations={[]} activeClassId="" taskType="detect" onChange={onChange} />);
    });

    const stage = container?.querySelector<HTMLDivElement>("[data-testid='stage']") as (HTMLDivElement & { getStage?: () => unknown; getClassName?: () => string; getPointerPosition?: () => { x: number; y: number } }) | null;
    expect(container?.textContent).toContain("请先在右侧新增一个类别");
    stage!.getStage = () => stage;
    stage!.getClassName = () => "Stage";
    stage!.getPointerPosition = () => ({ x: 10, y: 10 });
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => stage?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("zooms with ctrl+wheel, pans with ctrl+drag, and keeps drawn coordinates in image space", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[]} activeClassId="cls-1" taskType="detect" onChange={onChange} />);
    });

    const stage = container?.querySelector<HTMLDivElement>("[data-testid='stage']") as (HTMLDivElement & { getStage?: () => unknown; getClassName?: () => string; getPointerPosition?: () => { x: number; y: number } }) | null;
    let position = { x: 0, y: 0 };
    stage!.getStage = () => stage;
    stage!.getClassName = () => "Stage";
    stage!.getPointerPosition = () => position;

    // 图片 100x80 不缩放贴合，displaySize == 原图，便于断言坐标换算
    position = { x: 40, y: 20 };
    act(() => stage?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })));
    expect(container?.textContent).toContain("缩放 122%");

    act(() => stage?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 1000 })));
    expect(container?.textContent).toContain("缩放 100%");
    expect(container?.textContent).not.toContain("重置视图");

    position = { x: 20, y: 10 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true })));
    position = { x: 60, y: 40 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ctrlKey: true })));
    act(() => stage?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();

    // 平移 (40,30) 后，指针 (50,30)→(80,60) 应换算为图层坐标 (10,0)→(40,30)
    position = { x: 50, y: 30 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    position = { x: 80, y: 60 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    act(() => stage?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ type: "bbox", bbox: { x: 10, y: 0, width: 30, height: 30 } })]);

    const reset = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "重置视图");
    expect(reset).toBeTruthy();
    act(() => reset?.click());
    position = { x: 10, y: 10 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    position = { x: 40, y: 40 };
    act(() => stage?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type: "bbox", bbox: { x: 10, y: 10, width: 30, height: 30 } })]);
  });

  it("edits polygon vertices: drag moves one, double-click deletes one, keeps at least three", async () => {
    const polygonAnnotation: Annotation = { ...annotation, id: "ann-poly", type: "polygon", bbox: null, obb: null, polygon: [[10, 10], [50, 10], [50, 40], [10, 40], [20, 30]] };
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[polygonAnnotation]} activeClassId="cls-1" taskType="segment" onChange={onChange} selectedAnnotationId="ann-poly" />);
    });

    expect(container?.textContent).toContain("已选中多边形");

    const drags = container?.querySelectorAll<HTMLButtonElement>("[aria-label='拖动顶点']");
    expect(drags).toHaveLength(5);
    act(() => drags?.[0].click());
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type: "polygon", polygon: [[30, 40], [50, 10], [50, 40], [10, 40], [20, 30]] })]);

    const deletes = container?.querySelectorAll<HTMLButtonElement>("[aria-label='删除顶点']");
    act(() => deletes?.[1].click());
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type: "polygon", polygon: [[10, 10], [50, 40], [10, 40], [20, 30]] })]);

    // 只剩 3 个点时拒绝继续删除
    const calls = onChange.mock.calls.length;
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[{ ...polygonAnnotation, polygon: [[10, 10], [50, 10], [50, 40]] }]} activeClassId="cls-1" taskType="segment" onChange={onChange} selectedAnnotationId="ann-poly" />);
    });
    act(() => container?.querySelectorAll<HTMLButtonElement>("[aria-label='删除顶点']")[1]?.click());
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("adjusts placed vertices while drawing a polygon", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[]} activeClassId="cls-1" taskType="segment" onChange={onChange} />);
    });

    const stage = container?.querySelector<HTMLDivElement>("[data-testid='stage']") as (HTMLDivElement & { getStage?: () => unknown; getClassName?: () => string; getPointerPosition?: () => { x: number; y: number } }) | null;
    let position = { x: 0, y: 0 };
    stage!.getStage = () => stage;
    stage!.getClassName = () => "Stage";
    stage!.getPointerPosition = () => position;

    // 图片 100x80 原尺寸贴合，依次放置 3 个点
    for (const point of [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 40 }]) {
      position = point;
      act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    }
    expect(container?.textContent).toContain("3 个多边形点");
    expect(container?.textContent).toContain("已放置的顶点可直接拖动调整、双击删除");

    // 拖动第 1 个顶点到 (30,40)，完成多边形后坐标生效
    act(() => container?.querySelectorAll<HTMLButtonElement>("[aria-label='拖动顶点']")[0]?.click());
    const finish = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "完成多边形");
    act(() => finish?.click());
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ type: "polygon", polygon: [[30, 40], [50, 10], [50, 40]] })]);

    // 双击删除已放置的点
    for (const point of [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 40 }]) {
      position = point;
      act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    }
    act(() => container?.querySelectorAll<HTMLButtonElement>("[aria-label='删除顶点']")[2]?.click());
    expect(container?.textContent).toContain("2 个多边形点");
  });

  it("closes the polygon automatically when clicking near the first vertex", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[]} activeClassId="cls-1" taskType="segment" onChange={onChange} />);
    });

    const stage = container?.querySelector<HTMLDivElement>("[data-testid='stage']") as (HTMLDivElement & { getStage?: () => unknown; getClassName?: () => string; getPointerPosition?: () => { x: number; y: number } }) | null;
    let position = { x: 0, y: 0 };
    stage!.getStage = () => stage;
    stage!.getClassName = () => "Stage";
    stage!.getPointerPosition = () => position;

    for (const point of [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 40 }]) {
      position = point;
      act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    }

    // 远离第一个点点击：正常追加第 4 个点
    position = { x: 80, y: 60 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(container?.textContent).toContain("4 个多边形点");

    // 靠近第一个点悬停：光标提示可闭合
    position = { x: 15, y: 14 };
    act(() => stage?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    expect(stage!.style.cursor).toBe("pointer");

    // 点击即自动闭合，提交 4 个点的多边形
    act(() => stage?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ type: "polygon", polygon: [[10, 10], [50, 10], [50, 40], [80, 60]] })]);
    expect(container?.textContent).not.toContain("4 个多边形点");
  });

  it("inserts a vertex on double-clicked edge and simplifies dense polygons", async () => {
    const polygonAnnotation: Annotation = { ...annotation, id: "ann-poly", type: "polygon", bbox: null, obb: null, polygon: [[10, 10], [50, 10], [50, 40]] };
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[polygonAnnotation]} activeClassId="cls-1" taskType="segment" onChange={onChange} selectedAnnotationId="ann-poly" />);
    });

    // 双击边线：点击 (30,15) 投影到第一条边 (10,10)-(50,10) 的 (30,10)
    act(() => container?.querySelector<HTMLButtonElement>("[aria-label='双击边线']")?.click());
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ type: "polygon", polygon: [[10, 10], [30, 10], [50, 10], [50, 40]] })]);

    // 简化顶点：默认 2px 容差抽稀密集轮廓
    const dense: Annotation = { ...polygonAnnotation, polygon: [[0, 0], [5, 0], [10, 0], [15, 0], [20, 0], [20, 20], [10, 22], [0, 20]] };
    await act(async () => {
      root?.render(<AnnotationCanvas image={image} classes={classes} annotations={[dense]} activeClassId="cls-1" taskType="segment" onChange={onChange} selectedAnnotationId="ann-poly" />);
    });
    const simplify = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "简化顶点");
    act(() => simplify?.click());
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ polygon: [[0, 0], [20, 0], [20, 20], [0, 20]] })]);
  });
});
