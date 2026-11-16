import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionWatermark } from "../shell/watermark";

describe("SessionWatermark", () => {
  it("tiles the vendor's identity in grey over the session, never catching the pointer", () => {
    const html = renderToStaticMarkup(<SessionWatermark text={"vendor@acme.test<x>"} />);
    expect(html).toContain('data-testid="session-watermark"');
    expect(html).toContain("pointer-events:none");
    const img = decodeURIComponent(html);
    expect(img).toContain("vendor@acme.test");
    // The identity is escaped inside the SVG: no markup can come through it.
    expect(img).not.toContain("<x>");
    expect(img).toContain("#808080");
  });
  it("renders nothing when the resource has no watermark", () => {
    expect(renderToStaticMarkup(<SessionWatermark text={null} />)).toBe("");
  });
});
