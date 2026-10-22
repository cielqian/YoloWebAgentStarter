// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationView } from "./App";
import type { Annotation, ClassLabel, Dataset, ImageItem } from "./types";

vi.mock("./annotation/AnnotationCanvas", () => ({
  AnnotationCanvas: ({ onChange }: { onChange: (drafts: unknown[]) => void }) => (
    <button onClick={() => onChange([{ id: "ann-1", class_id: "cls-1", type: "obb", obb: { cx: 50, cy: 40, width: 60, height: 40, angle: 45 }, source: "manual" }])}>
      模拟旋转 OBB
    </button>
  ),
}));

const dataset: Dataset = { id: "ds-1", name: "vehicles", description: null, task_type: "obb", image_count: 1, annotated_image_count: 1, class_count: 1, created_at: "", updated_at: "" };
const image: ImageItem = { id: "img-1", dataset_id: dataset.id, file_name: "vehicle.png", width: 100, height: 80, split: "train", status: "annotated", file_url: "/api/images/img-1/file", created_at: "", updated_at: "" };
const secondImage: ImageItem = { ...image, id: "img-2", file_name: "vehicle-02.png", status: "unannotated" };
const classes: ClassLabel[] = [{ id: "cls-1", dataset_id: dataset.id, class_index: 0, name: "vehicle", color: "#22c55e", created_at: "", updated_at: "" }];
const personClass: ClassLabel = { id: "cls-2", dataset_id: dataset.id, class_index: 1, name: "person", color: "#3157d5", created_at: "", updated_at: "" };
const annotation: Annotation = { id: "ann-1", image_id: image.id, dataset_id: dataset.id, class_id: "cls-1", class_index: 0, label: "vehicle", color: "#22c55e", type: "obb", bbox: null, polygon: null, obb: { cx: 45, cy: 35, width: 30, height: 20, angle: 20 }, keypoints: null, source: "manual", created_at: "", updated_at: "" };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("AnnotationView persistence", () => {
  it("shows the complete image list and switches the active image", () => {
    const onImageSelect = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} images={[image, secondImage]} onImageSelect={onImageSelect} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    expect(container?.textContent).toContain("2 张图片");
    expect(container?.textContent).toContain("vehicle-02.png");
    expect(container?.textContent).toContain("未标注");
    const item = Array.from(container?.querySelectorAll<HTMLButtonElement>(".annotation-image-item") ?? []).find((button) => button.textContent?.includes("vehicle-02.png"));
    act(() => item?.click());
    expect(onImageSelect).toHaveBeenCalledWith(secondImage);
  });

  it("paginates the image list at twenty items", () => {
    const images = [image, ...Array.from({ length: 20 }, (_, index) => ({ ...image, id: `img-${index + 2}`, file_name: `vehicle-${index + 2}.png` }))];
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: images.length }} image={image} images={images} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(20);
    expect(container?.textContent).toContain("第 1 / 2 页");
    const next = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "下一页");
    act(() => next?.click());
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(1);
    expect(container?.textContent).toContain("vehicle-21.png");
  });

  it("filters the image list by train, val and test split", () => {
    const valImage = { ...secondImage, split: "val" as const };
    const testImage = { ...image, id: "img-3", file_name: "vehicle-03.png", split: "test" as const };
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 3 }} image={image} images={[image, valImage, testImage]} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(3);
    const valTab = container?.querySelector<HTMLButtonElement>(".annotation-image-split-tabs button:nth-child(3)");
    act(() => valTab?.click());

    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(1);
    expect(container?.textContent).toContain("vehicle-02.png");
    expect(container?.textContent).not.toContain("vehicle-03.png");
  });

  it("saves the edited OBB draft without its client-only id", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const rotate = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "模拟旋转 OBB");
    act(() => rotate?.click());
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([
      { id: "ann-1", class_id: "cls-1", type: "obb", obb: { cx: 50, cy: 40, width: 60, height: 40, angle: 45 }, source: "manual" },
    ]);
  });

  it("keeps pose keypoints through draft edits and passes the skeleton config", () => {
    const onSave = vi.fn();
    const poseDataset: Dataset = {
      ...dataset,
      task_type: "pose",
      pose_config: { kpt_count: 2, kpt_dim: 3, skeleton: [[0, 1]] },
    };
    const poseAnnotation: Annotation = {
      ...annotation,
      type: "pose",
      bbox: { x: 10, y: 10, width: 40, height: 40 },
      obb: null,
      keypoints: [[20, 20, 2], [40, 40, 1]],
    };
    act(() => {
      root?.render(<AnnotationView dataset={poseDataset} image={image} classes={classes} annotations={[poseAnnotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    // 不经画布改动：直接保存初始草稿，验证 keypoints 在 draft 序列化中保留。
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([
      { id: "ann-1", class_id: "cls-1", type: "pose", bbox: { x: 10, y: 10, width: 40, height: 40 }, polygon: undefined, obb: undefined, keypoints: [[20, 20, 2], [40, 40, 1]], source: "manual" },
    ]);
  });

  it("shows unsaved state after a draft changes", () => {
    const onDirtyChange = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onDirtyChange={onDirtyChange} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const rotate = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "模拟旋转 OBB");
    act(() => rotate?.click());

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(container?.textContent).toContain("未保存修改");
  });

  it("deletes one annotation from the list before saving", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const deleteButton = container?.querySelector<HTMLButtonElement>("button[aria-label='删除标注 1']");
    expect(deleteButton).toBeTruthy();
    act(() => deleteButton?.click());
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([]);
  });

  it("deletes the selected annotation with Delete", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const row = container?.querySelector<HTMLDivElement>(".shape-row");
    act(() => row?.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([]);
  });

  it("keeps previous and next navigation available by button and keyboard", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 2 }} image={image} images={[image, secondImage]} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onPrevious={onPrevious} onNext={onNext} hasPrevious hasNext onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const previous = container?.querySelector<HTMLButtonElement>(".annotation-navigation button:first-child");
    const next = container?.querySelector<HTMLButtonElement>(".annotation-navigation button:last-child");
    expect(previous?.textContent).toContain("上一张");
    expect(next?.textContent).toContain("下一张");
    act(() => next?.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it("passes current drafts to next navigation for auto-save", () => {
    const onNext = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 2 }} image={image} images={[image, secondImage]} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onPrevious={vi.fn()} onNext={onNext} hasPrevious hasNext onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const row = container?.querySelector<HTMLDivElement>(".shape-row");
    act(() => row?.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));

    const next = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent?.includes("下一张"));
    act(() => next?.click());
    expect(onNext).toHaveBeenCalledWith([]);
  });

  it("adds a custom class from the annotation sidebar", async () => {
    const onCreateClass = vi.fn(async () => personClass);
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onCreateClass={onCreateClass} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const open = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent?.includes("新增类别"));
    act(() => open?.click());
    const input = container?.querySelector<HTMLInputElement>("input[placeholder='例如：person']");
    expect(input).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(input, "person");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container?.querySelector<HTMLFormElement>(".annotation-class-form");
    await act(async () => { form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });

    expect(onCreateClass).toHaveBeenCalledWith("person", "#ef4444");
  });

  it("renders read-only with banner and disabled actions on a historical active version", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(
        <AnnotationView
          dataset={{ ...dataset, active_version_number: 1, latest_version_number: 2 }}
          image={image}
          classes={classes}
          annotations={[annotation]}
          activeClassId="cls-1"
          onClassChange={vi.fn()}
          onBack={vi.fn()}
          onSave={onSave}
          onSam={vi.fn()}
          onSamPoints={vi.fn()}
          busy={false}
          readOnly
        />,
      );
    });

    expect(container?.textContent).toContain("只读模式：当前激活的是历史版本 v1（最新 v2）");
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "保存标注");
    expect(save?.disabled).toBe(true);
    act(() => save?.click());
    expect(onSave).not.toHaveBeenCalled();
    const deleteAnnotation = container?.querySelector<HTMLButtonElement>(".annotation-delete-button");
    act(() => deleteAnnotation?.click());
    expect(container?.querySelectorAll(".shape-row")).toHaveLength(1);
  });

  it("toggles annotation visibility from the shape list", () => {
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const row = container?.querySelector<HTMLDivElement>(".shape-row");
    expect(row?.classList.contains("hidden")).toBe(false);
    const hide = row?.querySelector<HTMLButtonElement>(".annotation-visibility-button");
    expect(hide?.getAttribute("aria-label")).toBe("隐藏标注 1");

    act(() => hide?.click());
    expect(row?.classList.contains("hidden")).toBe(true);
    expect(hide?.getAttribute("aria-label")).toBe("显示标注 1");
    expect(hide?.getAttribute("aria-pressed")).toBe("true");

    act(() => hide?.click());
    expect(row?.classList.contains("hidden")).toBe(false);
  });

  it("hides and shows all annotations at once", () => {
    const secondAnnotation: Annotation = { ...annotation, id: "ann-2", class_id: "cls-1" };
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={classes} annotations={[annotation, secondAnnotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const rows = () => Array.from(container?.querySelectorAll<HTMLDivElement>(".shape-row") ?? []);
    const findButton = (label: string) => container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

    expect(rows()).toHaveLength(2);
    const showAll = findButton("全部显示");
    expect(showAll?.disabled).toBe(true);

    act(() => findButton("全部隐藏")?.click());
    expect(rows().every((row) => row.classList.contains("hidden"))).toBe(true);
    expect(findButton("全部隐藏")?.disabled).toBe(true);
    expect(showAll?.disabled).toBe(false);

    act(() => showAll?.click());
    expect(rows().every((row) => !row.classList.contains("hidden"))).toBe(true);
    expect(showAll?.disabled).toBe(true);
  });

  it("deletes an unused class and blocks deletion while a draft still uses it", async () => {
    const onDeleteClass = vi.fn(async () => true);
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} classes={[...classes, personClass]} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onDeleteClass={onDeleteClass} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const deleteButtons = Array.from(container?.querySelectorAll<HTMLButtonElement>(".annotation-class-delete") ?? []);
    expect(deleteButtons).toHaveLength(2);
    expect(deleteButtons[0].disabled).toBe(true); // vehicle 正被当前标注使用

    act(() => deleteButtons[1]?.click());
    const confirm = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "确认删除");
    await act(async () => confirm?.click());

    expect(onDeleteClass).toHaveBeenCalledWith(personClass.id);
  });

  it("allows changing an existing shape to another class", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, class_count: 2 }} image={image} classes={[...classes, personClass]} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const classSelect = container?.querySelector<HTMLSelectElement>(".shape-class-select");
    expect(classSelect).toBeTruthy();
    act(() => {
      if (classSelect) classSelect.value = personClass.id;
      classSelect?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([{ id: "ann-1", class_id: personClass.id, type: "obb", obb: { cx: 45, cy: 35, width: 30, height: 20, angle: 20 }, source: "manual" }]);
  });
});
