import { db } from "@/lib/db";
import { can, type Capability } from "@/lib/auth/roles";
import { fetchWithTimeout } from "@/lib/net/fetch-timeout";

/**
 * Push to the Captivo Admin app through Expo's push service (the relay to
 * APNs/FCM the app already uses for Portal). Devices are per workspace and
 * per app sign-in (MobileDevice), so one phone signed in to two workspaces
 * holds two rows and hears from both.
 *
 * Best-effort everywhere: a push never decides or delays anything. Callers run
 * inside the tenant's scope.
 */
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_CHUNK = 100;
const PUSH_TIMEOUT_MS = 5_000;

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

export function isExpoToken(token: unknown): token is string {
  return typeof token === "string" && token.length <= 200 && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(token);
}

/** Every phone of every active person in this workspace who holds `cap`. */
export async function pushToCapability(cap: Capability, payload: PushPayload): Promise<void> {
  try {
    const devices = await db.mobileDevice.findMany({
      where: { user: { status: "ACTIVE" }, session: { expiresAt: { gt: new Date() } } },
      select: { expoPushToken: true, user: { select: { role: true } } },
    });
    const tokens = devices.filter((d) => can(d.user.role, cap)).map((d) => d.expoPushToken);
    await sendExpo(tokens, payload);
  } catch (err) {
    console.warn("[push] send failed:", err instanceof Error ? err.message : err);
  }
}

async function sendExpo(tokens: string[], payload: PushPayload): Promise<void> {
  const valid = [...new Set(tokens.filter(isExpoToken))];
  const dead: string[] = [];
  for (let i = 0; i < valid.length; i += EXPO_CHUNK) {
    const batch = valid.slice(i, i + EXPO_CHUNK);
    const res = await fetchWithTimeout(EXPO_PUSH_URL, {
      timeoutMs: PUSH_TIMEOUT_MS,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(batch.map((to) => ({ to, sound: "default", title: payload.title, body: payload.body, data: payload.data }))),
    });
    const json = (await res.json().catch(() => null)) as { data?: Array<{ details?: { error?: string } }> } | null;
    (json?.data ?? []).forEach((t, j) => {
      if (t?.details?.error === "DeviceNotRegistered") dead.push(batch[j]);
    });
  }
  if (dead.length) await db.mobileDevice.deleteMany({ where: { expoPushToken: { in: dead } } });
}
