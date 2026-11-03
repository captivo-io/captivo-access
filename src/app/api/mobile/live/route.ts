import { liveRows } from "@/lib/live/rows";
import { mobileJson, mobileRoute } from "@/lib/mobile/route";

export const dynamic = "force-dynamic";

export const GET = mobileRoute("read_console", async () => mobileJson({ sessions: await liveRows() }));
