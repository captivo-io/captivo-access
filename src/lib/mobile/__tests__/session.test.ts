import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = { id: string; userId: string; tokenHash: string; mobile: boolean; mobileChallenge: string | null; expiresAt: Date; lastSeenAt: Date; user: { id: string; status: string; role: string } };
let rows: Row[] = [];
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const match = (r: Row, w: Record<string, unknown>) =>
  Object.entries(w).every(([k, v]) => {
    const val = (r as Record<string, unknown>)[k];
    if (v && typeof v === "object" && "not" in (v as object)) return val !== (v as { not: unknown }).not;
    return val === v;
  });

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      create: vi.fn(async ({ data }: { data: Row }) => { rows.push({ ...data, id: `s${rows.length + 1}`, lastSeenAt: new Date(), user: { id: data.userId, status: "ACTIVE", role: "ADMIN" } }); }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        rows = rows.filter((r) => !match(r, where));
        return { count: before - rows.length };
      }),
    },
  },
}));

import { issueMobileCode, redeemMobileCode, mobileSessionFromRequest } from "../session";

const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const bearer = (t: string) => new Request("https://acme.cloud.example/api/mobile/me", { headers: { authorization: `Bearer ${t}` } });

beforeEach(() => { rows = []; });

describe("app sign-in codes and tokens", () => {
  it("a code is redeemed once, for a token that is not the code", async () => {
    const code = await issueMobileCode("u1", challenge, { amr: ["mfa"] });
    const first = await redeemMobileCode(code, verifier, "iPhone");
    expect(first?.userId).toBe("u1");
    expect(first?.token).not.toBe(code);
    expect(await redeemMobileCode(code, verifier)).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0].mobileChallenge).toBeNull();
    expect(rows[0].tokenHash).toBe(sha(first!.token));
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it("a wrong verifier burns the code", async () => {
    const code = await issueMobileCode("u1", challenge, { amr: [] });
    expect(await redeemMobileCode(code, "w".repeat(64))).toBeNull();
    expect(rows).toHaveLength(0);
    expect(await redeemMobileCode(code, verifier)).toBeNull();
  });

  it("an expired code is refused", async () => {
    const code = await issueMobileCode("u1", challenge, { amr: [] });
    rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await redeemMobileCode(code, verifier)).toBeNull();
  });

  it("the code itself is never a bearer, the token is", async () => {
    const code = await issueMobileCode("u1", challenge, { amr: [] });
    expect(await mobileSessionFromRequest(bearer(code))).toBeNull();
    const { token } = (await redeemMobileCode(code, verifier))!;
    expect((await mobileSessionFromRequest(bearer(token)))?.user.id).toBe("u1");
  });

  it("a console cookie token is not a bearer", async () => {
    const web = "c".repeat(43);
    rows.push({ id: "w1", userId: "u1", tokenHash: sha(web), mobile: false, mobileChallenge: null, expiresAt: new Date(Date.now() + 3600e3), lastSeenAt: new Date(), user: { id: "u1", status: "ACTIVE", role: "ADMIN" } });
    expect(await mobileSessionFromRequest(bearer(web))).toBeNull();
  });

  it("a disabled person's token stops working", async () => {
    const code = await issueMobileCode("u1", challenge, { amr: [] });
    const { token } = (await redeemMobileCode(code, verifier))!;
    rows[0].user.status = "DISABLED";
    expect(await mobileSessionFromRequest(bearer(token))).toBeNull();
  });
});
