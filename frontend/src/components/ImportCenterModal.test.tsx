// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImportCenterModal } from "./ImportCenterModal";

vi.mock("../api/client", () => ({
  api: {
    listFtp: vi.fn().mockResolvedValue({
      path: "/export",
      entries: [
        { name: "export-v3", path: "/export/export-v3", is_dir: true, size: null, modified: null },
        { name: "ds.zip", path: "/export/ds.zip", is_dir: false, size: 2048, modified: null },
      ],
    }),
  },
}));

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

function findButton(text: string) {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === text);
}

/** React 受控 input 需要走原生 value setter 再派发事件，直接赋 value 会被忽略。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ImportCenterModal", () => {
  it("offers video import in the dataset import center", async () => {
    await act(async () => {
      root?.render(<ImportCenterModal busy={false} onClose={vi.fn()} onArchiveImport={vi.fn()} onFtpImport={vi.fn()} onVideoCompleted={vi.fn()} />);
    });
    expect(container?.textContent).toContain("YOLO 数据集");
    expect(container?.textContent).toContain("COCO 数据集");

    await act(async () => Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent?.includes("视频文件"))?.click());
    expect(container?.textContent).toContain("拖放或选择 MP4、MOV 或 AVI 视频");
    expect(container?.textContent).toContain("预检视频");

    const dropzone = container?.querySelector<HTMLButtonElement>(".video-import-form .exchange-dropzone");
    const file = new File(["video"], "dropped.mp4", { type: "video/mp4" });
    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
      dropzone?.dispatchEvent(event);
    });
    expect(container?.textContent).toContain("dropped.mp4");
  });

  it("selects an FTP directory for YOLO import in directory mode", async () => {
    const onFtpImport = vi.fn();
    await act(async () => {
      root?.render(<ImportCenterModal busy={false} onClose={vi.fn()} onArchiveImport={vi.fn()} onFtpImport={onFtpImport} onVideoCompleted={vi.fn()} />);
    });

    await act(async () => { findButton("FTP 选择")?.click(); });
    await act(async () => {});

    // ZIP 模式：目录只可浏览，没有勾选按钮
    expect(container?.querySelector(".import-ftp-pick")).toBeNull();
    expect(findButton("选当前目录")).toBeUndefined();

    await act(async () => { findButton("YOLO 目录")?.click(); });

    // 目录模式：目录行出现勾选按钮，zip 行禁用，且可选中当前目录
    const pick = container?.querySelector<HTMLButtonElement>('[aria-label="选择目录 export-v3"]');
    expect(pick).toBeTruthy();
    expect(findButton("选当前目录")).toBeTruthy();
    const zipRow = Array.from(container?.querySelectorAll<HTMLButtonElement>(".import-ftp-row.file") ?? [])[0];
    expect(zipRow?.disabled).toBe(true);

    await act(async () => { pick?.click(); });
    expect(container?.textContent).toContain("已选择:/export/export-v3");
    expect(container?.textContent).toContain("将递归采集");

    const nameInput = container?.querySelector<HTMLInputElement>('input[placeholder="例如：road-signs"]');
    await act(async () => { if (nameInput) setInputValue(nameInput, "ftp-dir-set"); });
    await act(async () => { findButton("开始导入")?.click(); });

    expect(onFtpImport).toHaveBeenCalledWith("/export/export-v3", "ftp-dir-set", "detect", "yolo", "dir");
  });

  it("keeps zip rows selectable in zip mode and passes source=zip", async () => {
    const onFtpImport = vi.fn();
    await act(async () => {
      root?.render(<ImportCenterModal busy={false} onClose={vi.fn()} onArchiveImport={vi.fn()} onFtpImport={onFtpImport} onVideoCompleted={vi.fn()} />);
    });

    await act(async () => { findButton("FTP 选择")?.click(); });
    await act(async () => {});

    const zipRow = Array.from(container?.querySelectorAll<HTMLButtonElement>(".import-ftp-row.file") ?? [])[0];
    expect(zipRow?.disabled).toBe(false);
    await act(async () => { zipRow?.click(); });
    expect(container?.textContent).toContain("已选择:/export/ds.zip");

    const nameInput = container?.querySelector<HTMLInputElement>('input[placeholder="例如：road-signs"]');
    await act(async () => { if (nameInput) setInputValue(nameInput, "ftp-zip-set"); });
    await act(async () => { findButton("开始导入")?.click(); });

    expect(onFtpImport).toHaveBeenCalledWith("/export/ds.zip", "ftp-zip-set", "detect", "yolo", "zip");
  });
});
