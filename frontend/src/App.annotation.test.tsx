// @vitest-environment jsdom

// antd 组件在 jsdom 里需要的浏览器 API mock
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
    });
  }
  if (!window.ResizeObserver) {
    class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
    (window as unknown as { ResizeObserver: object }).ResizeObserver = ResizeObserverMock;
  }
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {afterEach, beforeEach, describe, expect, it, vi, beforeAll} from "vitest";
import { AnnotationView } from "./App";

vi.mock("./components/confirm", () => ({ confirmDialog: vi.fn().mockResolvedValue(true), ConfirmProvider: () => null }));

// 侧栏图片列表走服务端分页:这里只替换分页接口,其余 api 保持原样
const listImagesPage = vi.hoisted(() => vi.fn());
vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return { ...actual, api: { ...actual.api, listImagesPage } };
});

/** 等侧栏那一页的请求回来 */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** 内存版分页接口:按 offset/limit/split/status/anchor 切片,对应后端的契约 */
function serveImages(all: ImageItem[]) {
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

const lastImageQuery = () => listImagesPage.mock.calls[listImagesPage.mock.calls.length - 1]?.[3];
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
  listImagesPage.mockReset();
  listImagesPage.mockResolvedValue({ items: [], total: 0, offset: 0 });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("AnnotationView persistence", () => {
  it("shows the current page from the server and switches the active image", async () => {
    const onImageSelect = vi.fn();
    serveImages([image, secondImage]);
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} onImageSelect={onImageSelect} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();

    // 进入时只发一次请求,并按当前图片定位
    expect(listImagesPage).toHaveBeenCalledTimes(1);
    expect(listImagesPage.mock.calls[0]).toEqual(["ds-1", 0, 20, { split: "", status: "", anchor: image.id }]);
    expect(container?.textContent).toContain("2 张图片");
    expect(container?.textContent).toContain("vehicle-02.png");
    expect(container?.textContent).toContain("未标注");
    const item = Array.from(container?.querySelectorAll<HTMLButtonElement>(".annotation-image-item") ?? []).find((button) => button.textContent?.includes("vehicle-02.png"));
    act(() => item?.click());
    expect(onImageSelect).toHaveBeenCalledWith(secondImage);
  });

  it("loads only the page being shown, twenty items at a time", async () => {
    const images = [image, ...Array.from({ length: 20 }, (_, index) => ({ ...image, id: `img-${index + 2}`, file_name: `vehicle-${index + 2}.png` }))];
    serveImages(images);
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: images.length }} image={image} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();

    // 首屏只有第 1 页的 20 条,但总数是整个数据集的
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(20);
    expect(container?.textContent).toContain("21 张图片");
    // 简洁分页:图标翻页 + 输入页码跳转
    const pager = container?.querySelector(".annotation-image-pager");
    expect(pager).toBeTruthy();
    expect(pager?.querySelector("input")?.value).toBe("1");
    expect(pager?.textContent).toContain("/2");

    // 翻到第 2 页:按 offset 再取一页,不带上 anchor
    const next = pager?.querySelector<HTMLButtonElement>(".ant-pagination-next button");
    act(() => next?.click());
    await settle();
    expect(listImagesPage).toHaveBeenCalledTimes(2);
    expect(listImagesPage.mock.calls[1]).toEqual(["ds-1", 20, 20, { split: "", status: "", anchor: undefined }]);
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(1);
    expect(container?.textContent).toContain("vehicle-21.png");
    expect(container?.querySelector(".annotation-image-item.active")).toBeNull();

    // 跳转回第 1 页:输入页码后失焦
    const jump = pager?.querySelector<HTMLInputElement>("input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(jump, "1");
      jump?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => jump?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await settle();
    expect(pager?.querySelector("input")?.value).toBe("1");
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(20);
    expect(container?.querySelector(".annotation-image-item.active")?.textContent).toContain("vehicle.png");
  });

  it("opens on the page that contains the current image", async () => {
    const images = Array.from({ length: 100 }, (_, index) => ({ ...image, id: `img-${index + 1}`, file_name: `v-${index + 1}.png`, status: "annotated" as const }));
    serveImages(images);
    // 第 46 张(下标 45)在每页 20 张的第 3 页
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 100 }} image={images[45]} onImageSelect={vi.fn()} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();

    expect(listImagesPage).toHaveBeenCalledTimes(1);
    expect(lastImageQuery()).toEqual({ split: "", status: "", anchor: "img-46" });
    expect(container?.querySelector<HTMLInputElement>(".annotation-image-pager input")?.value).toBe("3");
    const names = Array.from(container?.querySelectorAll(".annotation-image-item") ?? []).map((item) => item.textContent ?? "");
    expect(names[0]).toContain("v-41.png");
    expect(names[19]).toContain("v-60.png");
    expect(container?.querySelector(".annotation-image-item.active")?.textContent).toContain("v-46.png");
  });

  it("sends split and status filters to the server", async () => {
    const valImage = { ...secondImage, split: "val" as const };
    const testImage = { ...image, id: "img-3", file_name: "vehicle-03.png", split: "test" as const, status: "unannotated" as const };
    serveImages([image, valImage, testImage]);
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 3 }} image={image} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(3);

    const tab = (group: string, text: string) =>
      Array.from(container?.querySelectorAll<HTMLElement>(`.${group} .ant-segmented-item`) ?? []).find((item) => item.textContent === text);
    act(() => tab("annotation-image-split-tabs", "val")?.click());
    await settle();
    // 筛选在服务端做:总数是筛选后的数量;当前图片不在结果里时停在第 1 页
    expect(lastImageQuery()).toEqual({ split: "val", status: "", anchor: image.id });
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(1);
    expect(container?.textContent).toContain("1 张图片");
    expect(container?.textContent).toContain("vehicle-02.png");
    expect(container?.textContent).not.toContain("vehicle-03.png");

    act(() => tab("annotation-image-split-tabs", "全部")?.click());
    act(() => tab("annotation-image-split-tabs", "已标注")?.click());
    await settle();
    expect(lastImageQuery()).toEqual({ split: "", status: "annotated", anchor: image.id });
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(1);
    expect(container?.textContent).toContain("vehicle.png");
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
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 2 }} image={secondImage} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onPrevious={onPrevious} onNext={onNext} hasPrevious hasNext onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const buttons = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const previous = buttons.find((item) => item.textContent?.includes("上一张"));
    const next = buttons.find((item) => item.textContent?.includes("下一张"));
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
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 2 }} image={image} onImageSelect={vi.fn()} classes={classes} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onPrevious={vi.fn()} onNext={onNext} hasPrevious hasNext onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
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
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => (button.textContent ?? "").includes("确认删除"));
    await act(async () => confirm?.click());

    expect(onDeleteClass).toHaveBeenCalledWith(personClass.id);
  });

  it("allows changing an existing shape to another class", () => {
    const onSave = vi.fn();
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, class_count: 2 }} image={image} classes={[...classes, personClass]} annotations={[annotation]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={onSave} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });

    const classSelect = container?.querySelector<HTMLElement>(".shape-class-select");
    expect(classSelect).toBeTruthy();
    act(() => classSelect?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    const personOption = Array.from(document.querySelectorAll<HTMLElement>(".ant-select-item-option")).find((item) => item.getAttribute("title") === `${personClass.class_index}: ${personClass.name}`);
    expect(personOption).toBeTruthy();
    act(() => personOption?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const save = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "保存标注");
    act(() => save?.click());

    expect(onSave).toHaveBeenCalledWith([{ id: "ann-1", class_id: personClass.id, type: "obb", obb: { cx: 45, cy: 35, width: 30, height: 20, angle: 20 }, source: "manual" }]);
  });
});


describe("AnnotationView image batch delete", () => {
  it("multi-selects images and deletes them after confirmation", async () => {
    const onDeleteImages = vi.fn().mockResolvedValue(true);
    serveImages([image, secondImage]);
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 2 }} image={image} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} onDeleteImages={onDeleteImages} />);
    });
    await settle();

    const items = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>(".annotation-image-item"));
    expect(items().length).toBe(2);

    const batchToggle = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((btn) => btn.textContent === "多选");
    act(() => { batchToggle?.click(); });

    // 多选模式下点两张图片 = 勾选,不切换图片
    act(() => { items()[0]?.click(); });
    act(() => { items()[1]?.click(); });
    expect(document.body.querySelectorAll(".annotation-image-item.batch-checked").length).toBe(2);

    const del = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((btn) => btn.textContent?.includes("删除所选 2 张"));
    expect(del).toBeTruthy();
    await act(async () => { del?.click(); });

    const { confirmDialog } = await import("./components/confirm");
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "删除选中的 2 张图片？" }));
    expect(onDeleteImages).toHaveBeenCalledWith([image.id, secondImage.id]);
    // 删除成功后退出多选
    await act(async () => {});
    expect(Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).some((btn) => btn.textContent === "多选")).toBe(true);
  });
});

describe("AnnotationView 每页条数切换", () => {
  it("shows the whole list on one page after raising the page size", async () => {
    // 25 张图:每页 20 时 2 页,切到 50 后应收成 1 页并显示全部 25 条
    const images = Array.from({ length: 25 }, (_, index) => ({ ...image, id: `img-${index + 1}`, file_name: `v-${index + 1}.png` }));
    serveImages(images);
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 25 }} image={images[0]} onImageSelect={vi.fn()} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(20);

    const sizeOption = (size: string) =>
      Array.from(container?.querySelectorAll<HTMLElement>(".annotation-image-pagination .ant-segmented-item") ?? []).find((el) => el.textContent === size);
    act(() => sizeOption("50")?.click());
    await settle();

    expect(lastImageQuery()).toEqual({ split: "", status: "", anchor: images[0].id });
    expect(listImagesPage.mock.calls[listImagesPage.mock.calls.length - 1]?.slice(1, 3)).toEqual([0, 50]);
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(25);
    // 只有一页时分页器隐藏
    expect(container?.querySelector(".annotation-image-pager")).toBeNull();

    // 切回 20:重新定位到当前图片所在的页(第 1 页)
    act(() => sizeOption("20")?.click());
    await settle();
    expect(container?.querySelectorAll(".annotation-image-item")).toHaveLength(20);
    expect(container?.querySelector<HTMLInputElement>(".annotation-image-pager input")?.value).toBe("1");
  });

  it("re-fetches the page the user is on when the list version changes", async () => {
    const images = Array.from({ length: 30 }, (_, index) => ({ ...image, id: `img-${index + 1}`, file_name: `v-${index + 1}.png` }));
    serveImages(images);
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 30 }} image={images[0]} onImageSelect={vi.fn()} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} imageListVersion={0} />);
    });
    await settle();

    // 用户翻到第 2 页
    act(() => container?.querySelector<HTMLButtonElement>(".ant-pagination-next button")?.click());
    await settle();
    expect(container?.textContent).toContain("v-21.png");

    // 列表变化(如保存标注后):重取用户所在的第 2 页,而不是跳回当前图片那一页
    listImagesPage.mockClear();
    act(() => {
      root?.render(<AnnotationView dataset={{ ...dataset, image_count: 30 }} image={images[0]} onImageSelect={vi.fn()} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} imageListVersion={1} />);
    });
    await settle();

    expect(listImagesPage).toHaveBeenCalledTimes(1);
    expect(listImagesPage.mock.calls[0]).toEqual(["ds-1", 20, 20, { split: "", status: "", anchor: undefined }]);
    expect(container?.textContent).toContain("v-21.png");
  });

  it("shows an error instead of an empty list when the page fails to load", async () => {
    listImagesPage.mockRejectedValue(new Error("网络异常"));
    act(() => {
      root?.render(<AnnotationView dataset={dataset} image={image} onImageSelect={vi.fn()} classes={classes} annotations={[]} activeClassId="cls-1" onClassChange={vi.fn()} onBack={vi.fn()} onSave={vi.fn()} onSam={vi.fn()} onSamPoints={vi.fn()} busy={false} />);
    });
    await settle();

    expect(container?.textContent).toContain("图片列表加载失败：网络异常");
    expect(container?.querySelector(".annotation-image-item")).toBeNull();
  });
});
