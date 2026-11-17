// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AdminMessageBanner, type AdminMessage } from "../notices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const banner = () => document.querySelector(".ss-admin-msg");
const m = (id: string, text: string): AdminMessage => ({ id, text, at: "2026-11-18T00:00:00Z" });

describe("admin message on the user's session page", () => {
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "<div id=root></div>";
    root = createRoot(document.getElementById("root")!);
  });
  afterEach(() => vi.useRealTimers());

  it("shows a new message once, then hides it", async () => {
    await act(async () => root.render(<AdminMessageBanner message={m("a", "Please save your work")} />));
    expect(banner()?.textContent).toContain("Please save your work");
    expect(banner()?.getAttribute("role")).toBe("alert");
    await act(async () => { vi.advanceTimersByTime(12_500); });
    expect(banner()).toBeNull();
    // The poll keeps returning the same message for a while: it is not shown again.
    await act(async () => root.render(<AdminMessageBanner message={{ ...m("a", "Please save your work") }} />));
    expect(banner()).toBeNull();
  });

  it("shows the next message, and can be dismissed", async () => {
    await act(async () => root.render(<AdminMessageBanner message={m("a", "first")} />));
    await act(async () => root.render(<AdminMessageBanner message={m("b", "second")} />));
    expect(banner()?.textContent).toContain("second");
    await act(async () => { (banner()!.querySelector("button") as HTMLButtonElement).click(); });
    expect(banner()).toBeNull();
  });

  it("shows nothing without a message", async () => {
    await act(async () => root.render(<AdminMessageBanner message={null} />));
    expect(banner()).toBeNull();
  });
});
