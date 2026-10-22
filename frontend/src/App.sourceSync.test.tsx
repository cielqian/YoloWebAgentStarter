// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetHome } from "./App";
import type { Dataset } from "./types";

vi.mock("./api/client", () => {
  const tags = [
    { id: "stag-a", name: "白天", color: "#3157d5", image_count: 1 },
    { id: "stag-b", name: "夜间", color: "#22c55e", image_count: 2 },
  ];
  return {
    api: {
      listSourceDatasets: vi.fn().mockResolvedValue([
        { id: "sd-1", name: "路口抓拍", description: null, image_count: 3, tag_count: 2, created_at: "", updated_at: "" },
      ]),
      listSourceTags: vi.fn().mockResolvedValue(tags),
      listSourceImages: vi.fn().mockResolvedValue({ total: 3, offset: 0, limit: 1, items: [] }),
    },
    apiUrl: (path: string) => path,
  };
});

const dataset: Dataset = { id: "ds-1", name: "vehicles", description: null, task_type: "detect", image_count: 5, annotated_image_count: 0, class_count: 0, created_at: "", updated_at: "" };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

const clickButton = async (label: string | RegExp) => {
  const button = Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) =>
    typeof label === "string" ? (item.textContent ?? "").includes(label) : label.test(item.textContent ?? ""),
  );
  expect(button, `button ${String(label)} should exist`).toBeDefined();
  await act(async () => { button?.click(); });
  await act(async () => {});
};

describe("DatasetHome source sync dialog", () => {
  it("syncs images from a source dataset with tag filters", async () => {
    const { api } = await import("./api/client");
    const onSourceSync = vi.fn();
    await act(async () => {
      root?.render(
        <DatasetHome
          datasets={[dataset]}
          busy={false}
          onCreate={vi.fn()}
          onClone={vi.fn()}
          onImport={vi.fn()}
        onFtpImport={vi.fn()}
        onCancelImport={vi.fn()}
        onMergeYolo={vi.fn()}
          onValidate={vi.fn().mockResolvedValue(undefined)}
          onQuality={vi.fn().mockResolvedValue(undefined)}
          onContinueAnnotation={vi.fn()}
          onUpload={vi.fn()}
          onSourceSync={onSourceSync}
          onTrain={vi.fn()}
          onDuplicates={vi.fn().mockResolvedValue(undefined)}
          onDelete={vi.fn()}
        />,
      );
    });
    await act(async () => {});

    await clickButton("+ 添加图片");
    await clickButton("从数据源同步");
    expect(api.listSourceDatasets).toHaveBeenCalled();
    expect(api.listSourceTags).toHaveBeenCalledWith("sd-1");
    expect(container?.textContent).toContain("将同步 3 张图片");

    const chip = (name: string) =>
      Array.from(container?.querySelectorAll<HTMLButtonElement>(".source-tag-chip > button") ?? [])
        .find((item) => item.textContent?.startsWith(name));
    expect(chip("白天")).toBeDefined();
    await act(async () => { chip("白天")?.click(); });
    await act(async () => {});
    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { tagIds: ["stag-a"], tagMatch: "all", limit: 1 });

    await act(async () => { chip("夜间")?.click(); });
    await act(async () => {});
    const anyButton = Array.from(container?.querySelectorAll<HTMLButtonElement>(".tag-match-switch button") ?? []).find((item) => item.textContent === "或");
    expect(anyButton).toBeDefined();
    await act(async () => { anyButton?.click(); });
    await act(async () => {});
    expect(api.listSourceImages).toHaveBeenLastCalledWith("sd-1", { tagIds: ["stag-a", "stag-b"], tagMatch: "any", limit: 1 });

    await clickButton(/同步 \d+ 张图片/);
    expect(onSourceSync).toHaveBeenCalledWith(dataset, "sd-1", ["stag-a", "stag-b"], "any", "train");
    expect(container?.querySelector(".dataset-dialog")).toBeNull();
  });
});
