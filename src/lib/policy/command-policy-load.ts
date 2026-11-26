import { db } from "@/lib/db";
import { compileCommandList, type CompiledCommandList } from "@/lib/policy/command-lists";

/** The command list a resource enforces, compiled for the data plane; null when it has none. */
export async function commandPolicyFor(siteId: string): Promise<CompiledCommandList | null> {
  const s = await db.site.findUnique({ where: { id: siteId }, select: { commandList: { select: { name: true, mode: true, entries: true } } } });
  return compileCommandList(s?.commandList);
}
