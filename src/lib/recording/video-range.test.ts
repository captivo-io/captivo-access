import { describe, it, expect } from "vitest";
import { parseVideoRange, MAX_RANGE_BYTES } from "./video-range";

describe("recording video ranges", () => {
  it("an open-ended range is answered one connector frame at a time", () => {
    // The live failure: "bytes=5000000-" asked the connector for ~11 MB in one
    // 1 MiB-capped frame and came back empty.
    expect(parseVideoRange("bytes=5000000-")).toEqual({ wantsRange: true, fromByte: 5_000_000, toByte: 5_000_000 + MAX_RANGE_BYTES - 1 });
    expect(parseVideoRange("bytes=0-")).toEqual({ wantsRange: true, fromByte: 0, toByte: MAX_RANGE_BYTES - 1 });
  });

  it("a small explicit range is kept as asked", () => {
    expect(parseVideoRange("bytes=100-199")).toEqual({ wantsRange: true, fromByte: 100, toByte: 199 });
  });

  it("no header, a suffix range or a reversed one means the whole recording", () => {
    for (const h of [null, "bytes=-500", "bytes=9-3", "items=0-1", "bytes=0-1,5-9"]) {
      expect(parseVideoRange(h)).toEqual({ wantsRange: false, fromByte: 0, toByte: 0 });
    }
  });
});
