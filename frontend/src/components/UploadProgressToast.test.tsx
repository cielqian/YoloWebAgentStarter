// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UploadProgressToast } from "./UploadProgressToast";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); });

describe("UploadProgressToast", () => {
  it("shows the label, transferred bytes and percent while uploading", () => {
    act(() => {
      root?.render(<UploadProgressToast label="set.zip" progress={{ loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024, percent: 50 }} />);
    });
    expect(container?.textContent).toContain("正在上传 set.zip");
    expect(container?.textContent).toContain("5.0 MB / 10.0 MB · 50%");
    const track = container?.querySelector(".progress-track i");
    expect(track?.getAttribute("style")).toContain("width: 50%");
  });

  it("switches to the server-processing hint once the upload finishes", () => {
    act(() => {
      root?.render(<UploadProgressToast label="set.zip" progress={{ loaded: 10 * 1024 * 1024, total: 10 * 1024 * 1024, percent: 100 }} />);
    });
    expect(container?.textContent).toContain("set.zip 上传完成，服务器处理中…");
    expect(container?.textContent).toContain("100%");
  });

  it("omits the size summary when the total is unknown", () => {
    act(() => {
      root?.render(<UploadProgressToast label="images" progress={{ loaded: 0, total: 0, percent: 0 }} />);
    });
    expect(container?.textContent).toContain("正在上传 images");
    expect(container?.textContent).toContain("0%");
    expect(container?.textContent).not.toContain(" / ");
  });
});
