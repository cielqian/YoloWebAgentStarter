// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetVersionDialog } from "./DatasetVersionDialog";
import { api } from "../api/client";
import type { Dataset, DatasetVersion } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listDatasetVersions: vi.fn(),
    createDatasetVersion: vi.fn(),
    renameDatasetVersion: vi.fn(),
    activateDatasetVersion: vi.fn(),
    deleteDatasetVersion: vi.fn(),
  },
}));

const dataset: Dataset = { id: "ds-1", name: "vehicles", description: null, task_type: "detect", image_count: 3, annotated_image_count: 2, class_count: 1, created_at: "", updated_at: "" };
const active: DatasetVersion = { id: "v-2", dataset_id: "ds-1", version_number: 2, version_label: "v2", note: "第二轮", is_active: true, image_count: 3, annotation_count: 5, class_count: 1, has_pending_changes: true, created_at: "2026-10-19T10:00:00Z", updated_at: "" };
const inactive: DatasetVersion = { id: "v-1", dataset_id: "ds-1", version_number: 1, version_label: "v1", note: null, is_active: false, image_count: 2, annotation_count: 2, class_count: 1, created_at: "2026-10-18T10:00:00Z", updated_at: "" };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(api.listDatasetVersions).mockResolvedValue([active, inactive]);
  vi.mocked(api.createDatasetVersion).mockResolvedValue(active);
  vi.mocked(api.activateDatasetVersion).mockResolvedValue({ version: inactive, restored_images: 2, skipped_images: 1 });
  vi.mocked(api.deleteDatasetVersion).mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

const buttons = () => Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []);
const findButton = (text: string) => buttons().find((button) => button.textContent === text);

describe("DatasetVersionDialog", () => {
  it("loads and renders versions with active markers", async () => {
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={vi.fn()} />);
    });
    expect(api.listDatasetVersions).toHaveBeenCalledWith("ds-1");
    expect(container?.textContent).toContain("v2");
    expect(container?.textContent).toContain("第二轮");
    expect(container?.textContent).toContain("激活中");
    expect(container?.textContent).toContain("有未归档改动");
    expect(container?.textContent).toContain("（无备注）");
    expect(findButton("激活")).toBeTruthy();
  });

  it("creates a version from the note input and refreshes", async () => {
    const onChanged = vi.fn();
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={onChanged} />);
    });
    const input = container?.querySelector<HTMLInputElement>("input[placeholder='例如：修复了 20 张漏标']");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(input, "修复漏标");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { findButton("新建版本（快照当前数据）")?.click(); });

    expect(api.createDatasetVersion).toHaveBeenCalledWith("ds-1", "修复漏标", "");
    expect(api.listDatasetVersions).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalled();
  });

  it("creates a version with a custom label and renames inline", async () => {
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={vi.fn()} />);
    });
    const labelInput = container?.querySelector<HTMLInputElement>("input[placeholder='默认 v3']");
    expect(labelInput).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(labelInput, "20261028_返修版");
      labelInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { findButton("新建版本（快照当前数据）")?.click(); });
    expect(api.createDatasetVersion).toHaveBeenCalledWith("ds-1", "", "20261028_返修版");

    // 点击版本徽标进入行内重命名,保存调用 PATCH
    const badge = container?.querySelector<HTMLElement>(".dataset-version-badge");
    expect(badge?.textContent).toBe("v2");
    await act(async () => { badge?.click(); });
    const renameInput = container?.querySelector<HTMLInputElement>("input[aria-label='新版本号']");
    act(() => {
      setValue?.call(renameInput, "正式版");
      renameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { findButton("保存")?.click(); });
    expect(api.renameDatasetVersion).toHaveBeenCalledWith("ds-1", "v-2", "正式版");
  });

  it("activates a version directly when the workspace matches the snapshot", async () => {
    const onChanged = vi.fn();
    vi.mocked(api.listDatasetVersions).mockResolvedValue([{ ...active, has_pending_changes: false }, inactive]);
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={onChanged} />);
    });
    await act(async () => { findButton("激活")?.click(); });

    expect(api.activateDatasetVersion).toHaveBeenCalledWith("ds-1", "v-1");
    expect(onChanged).toHaveBeenCalled();
    expect(container?.textContent).toContain("已激活 v1：恢复 2 张图片，1 张因文件缺失被跳过");
  });

  it("asks to archive unarchived changes before switching versions", async () => {
    const onChanged = vi.fn();
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={onChanged} />);
    });
    await act(async () => { findButton("激活")?.click(); });

    expect(api.activateDatasetVersion).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("有未归档改动");
    expect(container?.textContent).toContain("切换到 v1");
    await act(async () => { findButton("归档并切换")?.click(); });

    expect(api.createDatasetVersion).toHaveBeenCalledWith("ds-1", "切换前自动归档");
    expect(api.activateDatasetVersion).toHaveBeenCalledWith("ds-1", "v-1");
    expect(onChanged).toHaveBeenCalled();
    expect(container?.textContent).toContain("已归档为 v2 并激活 v1");
  });

  it("can discard unarchived changes when switching versions", async () => {
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={vi.fn()} />);
    });
    await act(async () => { findButton("激活")?.click(); });
    await act(async () => { findButton("放弃改动并切换")?.click(); });

    expect(api.createDatasetVersion).not.toHaveBeenCalled();
    expect(api.activateDatasetVersion).toHaveBeenCalledWith("ds-1", "v-1");
  });

  it("deletes an inactive version only after confirmation", async () => {
    await act(async () => {
      root?.render(<DatasetVersionDialog dataset={dataset} onClose={vi.fn()} onChanged={vi.fn()} />);
    });
    act(() => { findButton("删除")?.click(); });
    expect(api.deleteDatasetVersion).not.toHaveBeenCalled();
    await act(async () => { findButton("确认删除")?.click(); });

    expect(api.deleteDatasetVersion).toHaveBeenCalledWith("ds-1", "v-1");
  });
});
