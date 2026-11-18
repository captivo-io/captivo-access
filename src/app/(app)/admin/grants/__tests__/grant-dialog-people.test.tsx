// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GrantUser } from "../grant-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
const { GrantDialogBody } = await import("../grant-dialog");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const users: GrantUser[] = [
  ...Array.from({ length: 10 }, (_, i): GrantUser => ({ id: `v${i}`, name: `Vendor ${i}`, email: `v${i}@partner.example`, role: "VENDOR", company: i === 3 ? "NetOps Ltd" : null })),
  { id: "a1", name: "Serdar Kurt", email: "serdar@acme.example", role: "ADMIN" },
  { id: "s1", name: "Staff One", email: "staff@acme.example", role: "STAFF" },
  { id: "d1", name: "Gone Vendor", email: "gone@partner.example", role: "VENDOR", status: "DISABLED" },
];
const names = () => [...document.querySelectorAll(".gd-user .gd-user-n")].map((n) => n.firstChild?.textContent);
const search = () => document.querySelector('input[aria-label="Search people"]') as HTMLInputElement;
function type(el: HTMLInputElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("new grant: finding a person", () => {
  beforeEach(async () => {
    document.body.innerHTML = "<div id=root></div>";
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<GrantDialogBody users={users} sites={[]} existing={[]} maxGrantDays={0} onDone={() => {}} onClose={() => {}} />));
  });

  it("lists only people who can sign in, as a compact list with a search", () => {
    expect(names()).toHaveLength(12);
    expect(names()).not.toContain("Gone Vendor");
    expect(document.querySelector(".gd-users.compact")).not.toBeNull();
    expect(document.body.textContent).toContain("12 people");
  });

  it("searches name, email and company, and Enter picks the first match", async () => {
    await act(async () => type(search(), "netops"));
    expect(names()).toEqual(["Vendor 3"]);
    await act(async () => search().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.querySelector(".gd-user.on .gd-user-n")?.firstChild?.textContent).toBe("Vendor 3");
    // The chosen person stays on top once the search is cleared.
    expect(names()[0]).toBe("Vendor 3");
  });

  it("filters by role", async () => {
    const consoleBtn = [...document.querySelectorAll('[aria-label="Role"] button')].find((b) => b.textContent === "Console") as HTMLButtonElement;
    await act(async () => consoleBtn.click());
    expect(names()).toEqual(["Serdar Kurt"]);
  });
});
