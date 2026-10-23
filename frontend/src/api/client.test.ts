import { afterEach, describe, expect, it, vi } from "vitest";
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
