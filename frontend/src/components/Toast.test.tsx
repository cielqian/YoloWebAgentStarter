// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("auto-closes after five seconds and restarts the timer on a new message", () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(<Toast kind="success" message="已保存" onClose={onClose} />);
    });
    expect(container?.textContent).toContain("已保存");

    act(() => { vi.advanceTimersByTime(4000); });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      root?.render(<Toast kind="success" message="类别已更新" onClose={onClose} />);
    });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(onClose).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(container?.textContent).toContain("类别已更新");
  });

  it("renders nothing without a message", () => {
    act(() => {
      root?.render(<Toast kind="error" message="" onClose={() => undefined} />);
    });
    expect(container?.textContent).toBe("");
  });
});
