import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getConnectorTelemetry, type HostActionStatus } from "@/lib/connector/telemetry";
import { foldHostAction, storedHostAction } from "@/lib/connector/host-action";

/** The scheduler's health pass runs every 5 minutes; each sample stands for that long. */
export const SAMPLE_MINUTES = 5;
/** Bars on the card's tunnel spark. */
export const SPARK_LENGTH = 16;
const EVENT_DAYS = 30;
const DAY_KEEP = 40;

export type EventLevel = "ok" | "warn" | "bad" | "info";
export type DayState = "ok" | "warn" | "bad" | "none";

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Notes something that happened to a connector. Best-effort: never fails its caller. */
export async function recordConnectorEvent(connectorId: string, level: EventLevel, text: string): Promise<void> {
  try {
    await db.connectorEvent.create({ data: { connectorId, level, text: text.slice(0, 300) } });
  } catch (e) {
    console.error("connector event not recorded", e);
  }
}

export interface UptimeSummary {
  /** Share of sampled time online over the window, 0..100; null before any sample. */
  pct: number | null;
  downtimeMin: number;
  days: { date: string; state: DayState; minutes: number }[];
}

/**
 * The 30-day strip: one entry per UTC day, oldest first, ending today. A day
 * with no samples is "none" (the connector did not exist yet, or history
 * started later); a day with any downtime under an hour is "warn"; more is "bad".
 */
export function summarizeUptime(rows: { day: string; samples: number; online: number }[], now: Date, span = 30): UptimeSummary {
  const by = new Map(rows.map((r) => [r.day, r]));
  let samples = 0, online = 0;
  const days: UptimeSummary["days"] = [];
  for (let i = span - 1; i >= 0; i--) {
    const date = dayKey(new Date(now.getTime() - i * 86_400_000));
    const r = by.get(date);
    if (!r || r.samples === 0) {
      days.push({ date, state: "none", minutes: 0 });
      continue;
    }
    samples += r.samples;
    online += r.online;
    const minutes = (r.samples - r.online) * SAMPLE_MINUTES;
    days.push({ date, state: minutes === 0 ? "ok" : minutes < 60 && r.online > 0 ? "warn" : "bad", minutes });
  }
  return {
    pct: samples ? (online / samples) * 100 : null,
    downtimeMin: (samples - online) * SAMPLE_MINUTES,
    days,
  };
}

export const pushSpark = (spark: number[], value: number) => [...spark, value].slice(-SPARK_LENGTH);

/**
 * One health pass for a tenant's connectors: whether each one's tunnel is up
 * (the data-plane's own view, not the stored status) and how many tunnels it
 * carries. Network only; the caller writes the result inside its scope. Null
 * when the data-plane cannot be asked: no sample beats a false outage.
 */
type Probe = { online: boolean; active: number; hostAction?: HostActionStatus };

export async function probeConnectors(ids: string[]): Promise<Map<string, Probe> | null> {
  const out = new Map<string, Probe>();
  const answers = await Promise.all(ids.map(async (id) => [id, await getConnectorTelemetry(id).catch(() => null)] as const));
  for (const [id, t] of answers) {
    if (!t || t.dataplaneDown) return null;
    out.set(id, { online: t.online, active: t.online ? (t.telemetry?.activeConnections ?? 0) : 0, hostAction: t.online ? t.telemetry?.hostAction : undefined });
  }
  return out;
}

/**
 * Brings a connector's stored host action up to date with what it reports, and
 * notes the outcome once it ends. Called from the health pass and from the
 * connector page's poll, so a result lands even when nobody is looking.
 */
export async function syncHostAction(connectorId: string, stored: unknown, report: HostActionStatus | null | undefined): Promise<void> {
  const r = foldHostAction(storedHostAction(stored), report);
  if (!r) return;
  await db.connector.update({ where: { id: connectorId }, data: { hostAction: r.next as unknown as Prisma.InputJsonValue } });
  if (r.event) await recordConnectorEvent(connectorId, r.event.level, r.event.text);
}

/** Writes one pass's samples and trims old history. Call inside the tenant scope. */
export async function writeConnectorSamples(
  rows: { id: string; tunnelSpark: number[]; hostAction?: unknown }[],
  probe: Map<string, Probe>,
  now: Date,
): Promise<void> {
  const day = dayKey(now);
  for (const c of rows) {
    const p = probe.get(c.id);
    if (!p) continue;
    await db.connectorDay.upsert({
      where: { connectorId_day: { connectorId: c.id, day } },
      create: { connectorId: c.id, day, samples: 1, online: p.online ? 1 : 0 },
      update: { samples: { increment: 1 }, online: { increment: p.online ? 1 : 0 } },
    });
    await db.connector.update({ where: { id: c.id }, data: { tunnelSpark: pushSpark(c.tunnelSpark, p.active) } });
    await syncHostAction(c.id, c.hostAction, p.hostAction);
  }
  await db.connectorEvent.deleteMany({ where: { at: { lt: new Date(now.getTime() - EVENT_DAYS * 86_400_000) } } });
  await db.connectorDay.deleteMany({ where: { day: { lt: dayKey(new Date(now.getTime() - DAY_KEEP * 86_400_000)) } } });
}
