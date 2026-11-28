import { describe, it, expect, vi } from "vitest";
import { explainFailure, OFFLINE_MESSAGE, silentFor, unreachableMessage } from "./unreachable";

describe("why a recording could not be played", () => {
  it("names the cause the server gave, not the HTTP status text", () => {
    expect(unreachableMessage(503, "connector_offline", "x")).toBe(OFFLINE_MESSAGE);
    expect(unreachableMessage(503, "no_connector", "x")).toContain("has no connector");
    expect(unreachableMessage(503, undefined, "x")).toContain("Try again in a moment");
    expect(unreachableMessage(401, undefined, "x")).toContain("Sign in again");
    expect(unreachableMessage(403, "forbidden", "x")).toContain("role");
    expect(unreachableMessage(404, "not_found", "x")).toContain("not found");
    expect(unreachableMessage(500, undefined, "Couldn't load this recording")).toBe("Couldn't load this recording (HTTP 500)");
    expect(OFFLINE_MESSAGE).not.toContain("Service Unavailable");
  });

  it("asks the server why a stream failed, and drops the stream when it turns out fine", async () => {
    const offline = vi.fn(async () => new Response(JSON.stringify({ error: "connector_offline", detail: "x" }), { status: 503 }));
    expect(await explainFailure("/r", "fallback", offline as never)).toBe(OFFLINE_MESSAGE);
    const fine = vi.fn(async () => new Response("bytes", { status: 200 }));
    expect(await explainFailure("/r", "fallback", fine as never)).toBe("fallback");
    const down = vi.fn(async () => { throw new Error("network"); });
    expect(await explainFailure("/r", "fallback", down as never)).toBe("fallback");
    const html = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await explainFailure("/r", "Couldn't play", html as never)).toBe("Couldn't play (HTTP 502)");
  });

  it("says how long a connector has been silent", () => {
    const now = new Date("2026-11-28T12:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect(silentFor(null, now)).toBe("never seen");
    expect(silentFor(ago(1), now)).toBe("just now");
    expect(silentFor(ago(45), now)).toBe("45 min ago");
    expect(silentFor(ago(17 * 60 + 5), now)).toBe("17 h ago");
    expect(silentFor(ago(3 * 24 * 60), now)).toBe("3 days ago");
  });
});
