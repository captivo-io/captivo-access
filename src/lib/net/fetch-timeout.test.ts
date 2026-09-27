import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchStreamWithHeaderTimeout, fetchWithTimeout } from "./fetch-timeout";

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithTimeout", () => {
  it("passes a signal and does not leak timeoutMs into the request", async () => {
    let seen: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response("ok");
    });
    await fetchWithTimeout("https://x/", { method: "POST", timeoutMs: 1234 });
    expect(seen?.signal, "no abort signal: the call can wait forever").toBeDefined();
    expect(seen).not.toHaveProperty("timeoutMs");
    expect(seen?.method).toBe("POST");
  });

  it("rejects when the far side never answers", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    await expect(fetchWithTimeout("https://x/", { timeoutMs: 20 })).rejects.toThrow();
  });
});

describe("fetchStreamWithHeaderTimeout", () => {
  it("stops timing once the head arrives, so a slow body is not aborted", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response("head-only");
    });
    const res = await fetchStreamWithHeaderTimeout("https://x/", { headerTimeoutMs: 15 });
    expect(res.ok).toBe(true);
    // Well past the header budget: the body must still be safe to read.
    await new Promise((r) => setTimeout(r, 50));
    expect(signal?.aborted, "the transfer was aborted after the head arrived").toBe(false);
    await expect(res.text()).resolves.toBe("head-only");
  });

  it("aborts when no head arrives in time", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    await expect(fetchStreamWithHeaderTimeout("https://x/", { headerTimeoutMs: 20 })).rejects.toThrow();
  });
});
