import { describe, it, expect, vi } from "vitest";
import { provisionEntitledWorkspace, suggestedSlug, type EntitledDeps } from "./entitled-flow";

// Each vi.fn() is given the interface's (wider, unioned) signature as an
// explicit type argument, rather than left to infer from the zero-arg
// implementation below -- otherwise reassigning a mock in a single test
// (e.g. to `async () => null`) fails typecheck against the narrower inferred
// type instead of the interface's.
const ok = () => ({
  fetchEntitlement: vi.fn<EntitledDeps["fetchEntitlement"]>(async () => ({ plan: "free", limits: { maxConnectors: 1, maxSites: 5 } })),
  create: vi.fn<EntitledDeps["create"]>(async () => ({ tenant: { id: "t_1", slug: "acme" }, inviteUrl: "https://acme.cloud.captivo.io/invite/tok" })),
  reportLink: vi.fn<EntitledDeps["reportLink"]>(async () => true),
  consoleOriginFor: (slug: string): string | null => `https://${slug}.cloud.captivo.io`,
});

const input = { organizationId: "org_1", organizationName: "Acme A.Ş.", slug: "acme", adminEmail: "a@b.co" };

describe("suggestedSlug", () => {
  it("derives a slug from the organisation name", () => {
    expect(suggestedSlug("Acme A.Ş.")).toBe("acme-a-s");
  });

  it("folds Turkish letters rather than dropping them", () => {
    // "Güneş Otel" losing its vowels would produce "gne-otel", which reads as
    // a typo to the customer whose address it becomes.
    expect(suggestedSlug("Güneş Otel")).toBe("gunes-otel");
  });

  it("never returns an empty slug", () => {
    expect(suggestedSlug("!!!")).not.toBe("");
    expect(suggestedSlug("")).not.toBe("");
  });
});

describe("provisionEntitledWorkspace", () => {
  it("creates the workspace on the free tier with the centre's caps", async () => {
    const d = ok();
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: true, inviteUrl: "https://acme.cloud.captivo.io/invite/tok", linked: true });
    expect(d.create.mock.calls[0]![0]).toMatchObject({
      name: "Acme A.Ş.", slug: "acme", adminEmail: "a@b.co",
      plan: "free", limits: { maxConnectors: 1, maxSites: 5 },
    });
  });

  it("refuses when the organisation has no ACCESS entitlement", async () => {
    // The entitlement is the authorisation. Without it this endpoint would
    // mint workspaces for anyone who can complete a Captivo ID login.
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => null);
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "not_entitled" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("reports the link AFTER the tenant exists, with its console origin", async () => {
    const d = ok();
    await provisionEntitledWorkspace(input, d);
    expect(d.reportLink).toHaveBeenCalledWith({
      organizationId: "org_1", tenantId: "t_1", consoleOrigin: "https://acme.cloud.captivo.io",
    });
  });

  it("still returns the invite when the link could not be reported", async () => {
    // The workspace exists and the invite expires in hours. Throwing it away
    // because the centre was briefly unreachable would cost the customer the
    // one thing they came for; `linked: false` is how the caller warns them.
    const d = ok();
    d.reportLink = vi.fn(async () => false);
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: true, inviteUrl: "https://acme.cloud.captivo.io/invite/tok", linked: false });
  });

  it("refuses caps that arrived but did not survive validation", async () => {
    // An uncapped free workspace is the one outcome the tier cannot afford, so
    // caps that were sent and then vanished must stop the creation rather than
    // silently mean "unlimited".
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ plan: "free", limits: { nonsense: 3 } }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "invalid_limits" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("refuses a slug the console domain cannot address", async () => {
    const d = ok();
    d.consoleOriginFor = () => null;
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "no_console_domain" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("surfaces a taken slug as a friendly error", async () => {
    const d = ok();
    d.create = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "slug_taken" }); });
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "slug_taken" });
  });
});
