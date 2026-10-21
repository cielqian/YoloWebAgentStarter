// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportCenterModal } from "./ImportCenterModal";
import type { FtpEntry } from "../types";

vi.mock("../api/client", () => ({
  api: {
    listFtp: vi.fn().mockResolvedValue({
      path: "/export",
      entries: [
        { name: "datasets", path: "/export/datasets", is_dir: true, size: null, modified: null },
        { name: "ds.zip", path: "/export/ds.zip", is_dir: false, size: 2048, modified: null },
        { name: "notes.txt", path: "/export/notes.txt", is_dir: false, size: 12, modified: null },
      ] satisfies FtpEntry[],
    }),
  },
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

const findButton = (text: string) => Array.from(container?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((item) => item.textContent === text);

describe("ImportCenterModal ftp picker", () => {
  it("enables the import button after picking a zip and typing a name", async () => {
    const onFtpImport = vi.fn();
    await act(async () => { root?.render(<ImportCenterModal busy={false} onClose={vi.fn()} onArchiveImport={vi.fn()} onFtpImport={onFtpImport} onVideoCompleted={vi.fn()} />); });

    await act(async () => { findButton("FTP 选择")?.click(); });
    await act(async () => { findButton("浏览")?.click(); });
    await act(async () => { findButton("🗜ds.zip2 KB")?.click(); });

    // 名称未手填时应自动取 zip 文件名，按钮随之可用
    const submit = findButton("开始导入");
    expect(submit).toBeTruthy();
    expect(submit?.disabled).toBe(false);

    const nameInput = container?.querySelector<HTMLInputElement>("input[placeholder='例如：road-signs']");
    expect(nameInput?.value).toBe("ds");

    await act(async () => { submit?.click(); });
    expect(onFtpImport).toHaveBeenCalledWith("/export/ds.zip", "ds", "detect", "yolo");
  });
});
