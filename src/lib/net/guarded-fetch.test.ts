import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const tenancy = { multi: true };
vi.mock("@/lib/tenant/enabled", () => ({ multiTenantEnabled: () => tenancy.multi }));
const { guardedRequest, tenantFetch, resolvePublic, PrivateAddressError } = await import("./guarded-fetch");

function server(): Promise<{ url: string; hits: () => number; close: () => void }> {
  let n = 0;
  const s = http.createServer((req, res) => { n++; req.resume(); res.end("ok"); });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`, hits: () => n, close: () => s.close(),
  })));
}

describe("guarded outbound calls", () => {
  afterEach(() => { tenancy.multi = true; });

  it("on Cloud refuses a private address before connecting", async () => {
    const s = await server();
    await expect(guardedRequest(s.url, { method: "POST", body: "x", timeoutMs: 2000 })).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(tenantFetch(s.url, { timeoutMs: 2000 })).rejects.toBeInstanceOf(PrivateAddressError);
    expect(s.hits()).toBe(0);
    s.close();
  });

  it("refuses names that resolve to the server's own network", async () => {
    await expect(resolvePublic("localhost")).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublic("169.254.169.254")).rejects.toBeInstanceOf(PrivateAddressError);
    await expect(resolvePublic("8.8.8.8")).resolves.toBe("8.8.8.8");
  });

  it("a self-hosted install may call its own network", async () => {
    tenancy.multi = false;
    const s = await server();
    const res = await tenantFetch(s.url, { method: "POST", body: "x", timeoutMs: 2000 });
    expect(await res.text()).toBe("ok");
    expect(s.hits()).toBe(1);
    s.close();
  });
});
