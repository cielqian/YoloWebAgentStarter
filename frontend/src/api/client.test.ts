import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

const sseResponse = (events: object[]) => {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  let readCount = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (readCount++ === 0 ? { done: false as const, value: bytes } : { done: true as const, value: undefined }),
      }),
    },
  };
};

describe("syncSourceFromFtp request body", () => {
  it("sends tag_ids and enum tag_values to the ftp-sync endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: "progress", synced: 1, total: 1 },
      { type: "done", synced: 1, skipped: 0 },
    ]));
    vi.stubGlobal("fetch", fetch);

    const result = await api.syncSourceFromFtp("sd-1", { path: "/cam1", recursive: true, tagIds: ["stag-a"], tagValues: { "stag-a": "强" } });

    expect(result).toEqual({ synced: 1, skipped: 0 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/source-datasets/sd-1/images/ftp-sync");
    expect(JSON.parse(String(init.body))).toEqual({
      path: "/cam1",
      recursive: true,
      tag_ids: ["stag-a"],
      tag_values: { "stag-a": "强" },
    });
  });
});

describe("upload progress via XHR", () => {
  class FakeXHR {
    static instances: FakeXHR[] = [];
    upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
    responseType = "";
    status = 0;
    response: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    openedUrl = "";
    constructor() { FakeXHR.instances.push(this); }
    open(_method: string, url: string) { this.openedUrl = url; }
    send(_body: FormData) { /* test drives the callbacks manually */ }
  }

  const file = new File(["zip"], "set.zip", { type: "application/zip" });

  beforeEach(() => { FakeXHR.instances = []; });

  it("reports upload percent and resolves with the parsed body", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const onProgress = vi.fn();
    const pending = api.importYolo(file, "set", "detect", false, undefined, onProgress);
    const xhr = FakeXHR.instances[FakeXHR.instances.length - 1]!;
    expect(xhr.openedUrl).toContain("/api/datasets/import/yolo?wait=false");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    expect(onProgress).toHaveBeenLastCalledWith({ loaded: 100, total: 100, percent: 100 });
    xhr.status = 200;
    xhr.response = { dataset: { id: "ds-1", name: "set" } };
    xhr.onload?.();
    await expect(pending).resolves.toEqual({ dataset: { id: "ds-1", name: "set" } });
  });

  it("ignores non-computable progress events", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const onProgress = vi.fn();
    const pending = api.importYolo(file, "set", "detect", false, undefined, onProgress);
    const xhr = FakeXHR.instances[FakeXHR.instances.length - 1]!;
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    expect(onProgress).not.toHaveBeenCalled();
    xhr.status = 500;
    xhr.response = null;
    xhr.onload?.();
    await expect(pending).rejects.toThrow("Request failed (500)");
  });

  it("surfaces the backend error message on failure", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const pending = api.importYolo(file, "set", "detect", false, undefined, vi.fn());
    const xhr = FakeXHR.instances[FakeXHR.instances.length - 1]!;
    xhr.status = 400;
    xhr.response = { error: { message: "invalid_archive" } };
    xhr.onload?.();
    await expect(pending).rejects.toThrow("invalid_archive");
  });

  it("falls back to fetch when no progress callback is given", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ dataset: { id: "ds-2", name: "set" } }) });
    vi.stubGlobal("fetch", fetch);
    await api.importYolo(file, "set", "detect", false);
    expect(fetch).toHaveBeenCalled();
  });
});
