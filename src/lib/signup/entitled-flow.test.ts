import { describe, it, expect, vi } from "vitest";
import { provisionEntitledWorkspace, suggestedSlug, type EntitledDeps } from "./entitled-flow";

// Each vi.fn() is given the interface's (wider, unioned) signature as an
// explicit type argument, rather than left to infer from the zero-arg
// implementation below -- otherwise reassigning a mock in a single test
// (e.g. to `async () => null`) fails typecheck against the narrower inferred
// type instead of the interface's.
const ok = () => ({
  fetchEntitlement: vi.fn<EntitledDeps["fetchEntitlement"]>(async () => ({ status: "ok" as const, plan: "free", limits: { maxConnectors: 1, maxSites: 5 }, expiresAt: null })),
  findWorkspaceForOrg: vi.fn<EntitledDeps["findWorkspaceForOrg"]>(async () => null),
  create: vi.fn<EntitledDeps["create"]>(async () => ({ tenant: { id: "t_1", slug: "acme" }, inviteUrl: "https://acme.cloud.captivo.io/invite/tok" })),
  reportLink: vi.fn<EntitledDeps["reportLink"]>(async () => true),
  consoleOriginFor: (slug: string): string | null => `https://${slug}.cloud.captivo.io`,
  // Fixed so the expiry decision never depends on when the suite runs.
  now: () => new Date("2026-06-01T00:00:00.000Z"),
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
    d.fetchEntitlement = vi.fn(async () => ({ status: "none" as const }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "not_entitled" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("says the centre was unreachable rather than calling the organisation unentitled", async () => {
    // Silence from the centre is not a refusal by the centre. Answering
    // not_entitled told someone holding a valid grant something untrue, and
    // left them nothing to do about it.
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ status: "unavailable" as const, reason: "unreachable" as const }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "centre_unavailable" });
  });

  it("creates nothing when the centre cannot be reached", async () => {
    // Fail closed: the distinct error above must not have turned an
    // unanswered question into a workspace.
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ status: "unavailable" as const, reason: "unreachable" as const }));
    await provisionEntitledWorkspace(input, d);
    expect(d.create).not.toHaveBeenCalled();
  });

  it("refuses an entitlement that has already lapsed", async () => {
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ status: "ok" as const, plan: "free", limits: null, expiresAt: "2026-05-31T23:59:59.000Z" }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "entitlement_expired" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("accepts an entitlement that has not lapsed yet", async () => {
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ status: "ok" as const, plan: "free", limits: null, expiresAt: "2026-06-01T00:00:01.000Z" }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toMatchObject({ ok: true });
  });

  it("refuses an expiry it cannot read rather than reading it as \"never\"", async () => {
    // An unparseable expiry means we do not know whether the grant is live.
    const d = ok();
    d.fetchEntitlement = vi.fn(async () => ({ status: "ok" as const, plan: "free", limits: null, expiresAt: "whenever" }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "entitlement_expired" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("refuses a second workspace for an organisation that already has one", async () => {
    // After provisioning, the person still has no user and no invite in the
    // platform tenant, so the next sign-in walks the same branch. Without this
    // each pass mints another workspace carrying the free tier's connector
    // allowance.
    const d = ok();
    d.findWorkspaceForOrg = vi.fn(async () => ({ slug: "acme" }));
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "already_provisioned", existingSlug: "acme" });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("proceeds when the organisation has no workspace yet", async () => {
    const d = ok();
    const r = await provisionEntitledWorkspace(input, d);
    expect(d.findWorkspaceForOrg).toHaveBeenCalledWith("org_1");
    expect(r).toMatchObject({ ok: true });
    expect(d.create).toHaveBeenCalled();
  });

  it("records the organisation on the tenant it creates", async () => {
    // The refusal above can only work if the organisation is written down at
    // creation time; nothing else in the schema remembers it.
    const d = ok();
    await provisionEntitledWorkspace(input, d);
    expect(d.create.mock.calls[0]![0]).toMatchObject({ captivoOrgId: "org_1" });
  });

  it("reports a lost race on the organisation as already_provisioned", async () => {
    // The unique index is the backstop behind findWorkspaceForOrg; when it
    // fires, the answer must still be "you already have one", not "pick
    // another address".
    const d = ok();
    d.create = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "org_taken" }); });
    const r = await provisionEntitledWorkspace(input, d);
    expect(r).toEqual({ ok: false, error: "already_provisioned" });
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
    d.fetchEntitlement = vi.fn(async () => ({ status: "ok" as const, plan: "free", limits: { nonsense: 3 }, expiresAt: null }));
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
