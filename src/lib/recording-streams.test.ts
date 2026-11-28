import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A recording holds several streams under one key -- a guac session stores its
 * instruction stream and its keystrokes at once -- so every replay route has to
 * name the stream it wants. TypeScript already refuses a route that names none.
 * This covers the other half: a route that names the WRONG one still compiles, and
 * the symptom is a player that loads forever rather than an error anyone can read.
 */
const ROUTE_STREAM: Record<string, string> = {
  guac: "guac",
  events: "rrweb",
  video: "video",
  keyevents: "keys",
  term: "term",
};

describe("recording replay routes", () => {
  for (const [route, stream] of Object.entries(ROUTE_STREAM)) {
    it(`${route} asks its holders for the "${stream}" stream`, () => {
      const src = readFileSync(`src/app/api/admin/recordings/[id]/${route}/route.ts`, "utf8");
      // The original holder or a copy of it (src/lib/recording/holders.ts): either way the route names its stream.
      const call = src.slice(src.indexOf("fetchFromHolders(rec,"), src.indexOf("fetchFromHolders(rec,") + 80);
      expect(call).toContain(`fetchFromHolders(rec, "${stream}"`);
      for (const other of Object.values(ROUTE_STREAM)) {
        if (other !== stream) expect(call).not.toContain(`fetchFromHolders(rec, "${other}"`);
      }
    });
  }
});
