import { describe, it, expect } from "vitest";
import { adminActionLabel, adminCategory, adminMergedSummary, isAdminCategory } from "./admin-actions";

describe("adminActionLabel", () => {
  it("maps known actions to human labels", () => {
    expect(adminActionLabel("session.terminate")).toBe("Session terminated");
    expect(adminActionLabel("grant.update")).toBe("Grant updated");
    expect(adminActionLabel("resource.vault_update")).toBe("Resource credential updated");
    expect(adminActionLabel("config.smtp_update")).toBe("SMTP settings updated");
    expect(adminActionLabel("recording.delete")).toBe("Recording deleted");
  });
  it("labels the newer actions instead of showing their raw names", () => {
    expect(adminActionLabel("credential.checkout")).toBe("Password checked out");
    expect(adminActionLabel("review.decide")).toBe("Access review decision recorded");
    expect(adminActionLabel("session_invite.create")).toBe("Guest invited to a session");
    expect(adminActionLabel("resource.elevation_update")).toBe("Administrator rights during sessions changed");
    expect(adminActionLabel("config.ticketing_test")).toBe("Ticketing connection tested");
  });
  it("falls back to the raw action for unknown values", () => {
    expect(adminActionLabel("something.new")).toBe("something.new");
  });
});

describe("adminCategory", () => {
  it("files each action under its page filter", () => {
    expect(adminCategory("connector.pairing_delete")).toBe("connector");
    expect(adminCategory("config.log_level_reset")).toBe("connector");
    expect(adminCategory("recording.erasure_requested")).toBe("recording");
    expect(adminCategory("grant.revoke")).toBe("access");
    expect(adminCategory("session.terminate")).toBe("access");
    expect(adminCategory("resource.vault_update")).toBe("resource");
    expect(adminCategory("config.sso_remove")).toBe("identity");
    expect(adminCategory("authsession.revoke")).toBe("identity");
    expect(adminCategory("config.smtp_update")).toBe("settings");
    expect(adminCategory("review.close")).toBe("access");
    expect(adminCategory("credential.checkin")).toBe("access");
    expect(adminCategory("session_invite.join")).toBe("access");
    expect(adminCategory("site.ssh_host_key_forget")).toBe("resource");
    expect(adminCategory("agent.token_create")).toBe("identity");
    expect(adminCategory("config.log_destination_create")).toBe("settings");
    expect(adminCategory("something.new")).toBe("settings");
  });
  it("accepts only the known category names", () => {
    expect(isAdminCategory("recording")).toBe(true);
    expect(isAdminCategory("toString")).toBe(false);
    expect(isAdminCategory(null)).toBe(false);
  });
});

describe("adminMergedSummary", () => {
  it("keeps a single entry's summary", () => {
    expect(adminMergedSummary("grant.revoke", 1, "Revoked x")).toBe("Revoked x");
  });
  it("words a merged run of a known action", () => {
    expect(adminMergedSummary("recording.erasure_requested", 9, "…")).toBe("Requested erasure of 9 recordings (applied when their connectors confirm)");
  });
  it("falls back to the count and the newest summary", () => {
    expect(adminMergedSummary("user.update", 3, "Changed role")).toBe("3 times. Latest: Changed role");
  });
});

describe("every recorded admin action has a label", () => {
  it("scans the source for recordAdminAction calls and finds no raw names", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== "generated" && f !== "node_modules") walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(f) || /\.test\./.test(f)) continue;
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/recordAdminAction\(/g)) {
          const seg = src.slice(m.index! + m[0].length, m.index! + m[0].length + 900);
          for (const a of seg.matchAll(/action:\s*(?:\w+\s*(?:===|!==)\s*"[^"]*"\s*\?\s*)?"([a-z_]+(?:\.[a-z_]+)+)"(?:\s*:\s*"([a-z_]+(?:\.[a-z_]+)+)")?/g)) {
            found.add(a[1]);
            if (a[2]) found.add(a[2]);
            break;
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(found.size).toBeGreaterThan(60);
    const raw = [...found].filter((a) => adminActionLabel(a) === a);
    expect(raw, `actions with no label: ${raw.join(", ")}`).toEqual([]);
  });
});
