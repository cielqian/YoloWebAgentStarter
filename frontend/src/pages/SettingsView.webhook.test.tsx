// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// antd 组件在 jsdom 里需要的浏览器 API mock
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }),
    });
  }
  if (!window.ResizeObserver) {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: object }).ResizeObserver = ResizeObserverMock;
  }
});

import { SettingsView } from "./SettingsView";
import type { WebhookSettings } from "../types";

const { getWebhookSettings, updateWebhookSettings } = vi.hoisted(() => ({
  getWebhookSettings: vi.fn(),
  updateWebhookSettings: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: { getWebhookSettings, updateWebhookSettings },
  apiUrl: (path: string) => path,
}));

const PRESET_STARTED = '{"msgtype":"text","text":{"content":"🚀 训练启动：{task_name}\n数据集：{dataset}"}}';
const DEFAULT_SETTINGS: WebhookSettings = {
  enabled: true,
  url: "http://hook.test/notify",
  method: "POST",
  events: ["started", "completed", "failed"],
  body_templates: { started: PRESET_STARTED, completed: '{"msgtype":"text","text":{"content":"✅ 训练完成：{task_name}"}}', failed: "err {error_message}", stopped: "" },
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  getWebhookSettings.mockResolvedValue({ ...DEFAULT_SETTINGS });
  updateWebhookSettings.mockImplementation(async (payload: WebhookSettings) => payload);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function textareaByLabel(label: string): HTMLTextAreaElement {
  const labelEl = Array.from(container!.querySelectorAll("label")).find((el) => el.textContent?.includes(label));
  if (!labelEl) throw new Error(`label not found: ${label}`);
  const textarea = labelEl.querySelector("textarea");
  if (!textarea) throw new Error(`textarea not found under label: ${label}`);
  return textarea as HTMLTextAreaElement;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickSave() {
  const button = Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find((el) =>
    el.textContent?.includes("保存 Webhook 设置"),
  );
  if (!button) throw new Error("save button not found");
  return act(async () => {
    button.click();
  });
}

describe("SettingsView webhook 按事件模板", () => {
    it("渲染四类事件模板(预置完整模板回显),不再有通用模板", async () => {
    await act(async () => {
      root?.render(<SettingsView tab="webhook" locale="zh" onTabChange={() => undefined} onLocaleChange={() => undefined} />);
    });
    await act(async () => {});

    const genericLabel = Array.from(container!.querySelectorAll("label")).find((el) => el.textContent?.includes("通用请求体模板"));
    expect(genericLabel).toBeUndefined();
    expect(textareaByLabel("训练启动").value).toContain("🚀 训练启动：{task_name}");
    expect(textareaByLabel("训练完成").value).toContain("✅ 训练完成");
    expect(textareaByLabel("训练失败").value).toBe("err {error_message}");
    expect(textareaByLabel("训练停止").value).toBe("");
    // 启动/完成/异常 三态默认选中,停止默认不选
    const checked = Array.from(container!.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map((el) => el.closest("label")?.textContent ?? "");
    expect(checked.some((t) => t.includes("训练启动"))).toBe(true);
    expect(checked.some((t) => t.includes("训练完成"))).toBe(true);
    expect(checked.some((t) => t.includes("训练失败"))).toBe(true);
    expect(checked.some((t) => t.includes("训练停止"))).toBe(false);
  });

  it("编辑事件模板后保存提交 body_templates", async () => {
    await act(async () => {
      root?.render(<SettingsView tab="webhook" locale="zh" onLocaleChange={() => undefined} onTabChange={() => undefined} />);
    });
    await act(async () => {});

    typeInto(textareaByLabel("训练启动"), "🚀 {task_name} v{dataset_version}");
    await clickSave();
    await act(async () => {});

    expect(updateWebhookSettings).toHaveBeenCalledTimes(1);
    const payload = updateWebhookSettings.mock.calls[0][0] as WebhookSettings;
    expect(payload.body_templates.started).toBe("🚀 {task_name} v{dataset_version}");
    expect(payload.body_templates.failed).toBe("err {error_message}");
  });
});
