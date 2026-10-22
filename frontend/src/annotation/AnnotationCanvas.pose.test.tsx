// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationCanvas } from "./AnnotationCanvas";
import type { Annotation, ClassLabel, ImageItem } from "../types";

vi.mock("react-konva", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
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
    Circle: ({ onDragEnd, onDblClick }: any) => (
      <div>
        {onDragEnd && <button aria-label="拖动关键点" onClick={() => onDragEnd({ target: { x: () => 30, y: () => 40 } })}></button>}
        {onDblClick && <button aria-label="切换关键点" onClick={onDblClick}></button>}
      </div>
    ),
    Line: () => <div data-testid="skeleton-edge" />,
    Rect: forwardRef((_props: any, ref) => {
      const { onClick } = _props;
      useImperativeHandle(ref, () => null);
      return <div>{onClick && <button aria-label="选中姿态" onClick={onClick}>pose</button>}</div>;
    }),
    Text: () => <span data-testid="kpt-label" />,
    Transformer: forwardRef((_props: any, ref) => {
      useImperativeHandle(ref, () => ({ nodes: () => undefined, getLayer: () => ({ batchDraw: () => undefined }) }));
      return <div data-testid="transformer" />;
    }),
  };
});

const image: ImageItem = {
  id: "img-1",
  dataset_id: "ds-1",
  file_name: "person.png",
  width: 100,
  height: 80,
  split: "train",
  status: "annotated",
  file_url: "/api/images/img-1/file",
  created_at: "",
  updated_at: "",
};

const classes: ClassLabel[] = [{ id: "cls-1", dataset_id: "ds-1", class_index: 0, name: "person", color: "#22c55e", created_at: "", updated_at: "" }];

const poseAnnotation: Annotation = {
  id: "ann-pose",
  image_id: image.id,
  dataset_id: image.dataset_id,
  class_id: classes[0].id,
  class_index: 0,
  label: "person",
  color: classes[0].color,
  type: "pose",
  bbox: { x: 10, y: 10, width: 60, height: 60 },
  polygon: null,
  obb: null,
  keypoints: [[20, 20, 2], [50, 20, 1], [0, 0, 0]],
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

describe("AnnotationCanvas pose", () => {
  it("renders the skeleton, keypoint handles and index labels for a selected pose", () => {
    act(() => {
      root?.render(
        <AnnotationCanvas
          image={image}
          annotations={[poseAnnotation]}
          activeClassId="cls-1"
          selectedAnnotationId="ann-pose"
          taskType="pose"
          poseConfig={{ kpt_count: 3, kpt_dim: 3, skeleton: [[0, 1], [1, 2]] }}
          onChange={vi.fn()}
        />,
      );
    });

    expect(container?.querySelectorAll('[data-testid="skeleton-edge"]')).toHaveLength(1); // 只有 0-1 两个点已标注
    expect(container?.querySelectorAll('[aria-label="拖动关键点"]')).toHaveLength(3);
    expect(container?.querySelectorAll('[data-testid="kpt-label"]')).toHaveLength(3);
  });

  it("marks a dragged keypoint as visible and clamps it into the image", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <AnnotationCanvas
          image={image}
          annotations={[poseAnnotation]}
          activeClassId="cls-1"
          selectedAnnotationId="ann-pose"
          taskType="pose"
          poseConfig={{ kpt_count: 3, kpt_dim: 3 }}
          onChange={onChange}
        />,
      );
    });

    const handles = container?.querySelectorAll<HTMLButtonElement>('[aria-label="拖动关键点"]');
    act(() => handles?.[2]?.click());

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Array<{ type: string; keypoints?: number[][] }>;
    const updated = last.find((item) => item.type === "pose");
    // 舞台 (30,40) 在默认 900×620 显示尺寸下换算回 100×80 原图
    expect(updated?.keypoints?.[2]).toEqual([expect.closeTo(3.33, 1), expect.closeTo(5.16, 1), 2]);
    expect(updated?.keypoints?.[0]).toEqual([20, 20, 2]);
  });

  it("toggles a keypoint between labeled and unlabeled on double click", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <AnnotationCanvas
          image={image}
          annotations={[poseAnnotation]}
          activeClassId="cls-1"
          selectedAnnotationId="ann-pose"
          taskType="pose"
          poseConfig={{ kpt_count: 3, kpt_dim: 3 }}
          onChange={onChange}
        />,
      );
    });

    const toggles = container?.querySelectorAll<HTMLButtonElement>('[aria-label="切换关键点"]');
    act(() => toggles?.[0]?.click());

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Array<{ type: string; keypoints?: number[][] }>;
    const updated = last.find((item) => item.type === "pose");
    expect(updated?.keypoints?.[0]?.[2]).toBe(0); // 2 → 0
  });

  it("does not offer keypoint editing in read-only mode", () => {
    act(() => {
      root?.render(
        <AnnotationCanvas
          image={image}
          annotations={[poseAnnotation]}
          activeClassId="cls-1"
          selectedAnnotationId="ann-pose"
          taskType="pose"
          poseConfig={{ kpt_count: 3, kpt_dim: 3 }}
          onChange={vi.fn()}
          readOnly
        />,
      );
    });

    expect(container?.querySelectorAll('[aria-label="拖动关键点"]')).toHaveLength(0);
  });
});
