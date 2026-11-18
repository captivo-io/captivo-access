// Pure validation for an uploaded Site logo. The upload arrives as base64 (or a
// data: URL) plus a MIME type; this decodes + bounds it. SVG is allowed because
// the logo is only ever rendered via <img> (which cannot execute scripts) and
// the serving route sends a sandboxing CSP.
export const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
]);
export const MAX_LOGO_BYTES = 512 * 1024; // 512 KB

export type LogoUpdate =
  | { action: "keep" } // field absent -> leave the existing logo unchanged
  | { action: "clear" } // explicit null/empty -> remove the logo
  | { action: "set"; data: Uint8Array<ArrayBuffer>; type: string }
  | { action: "error"; error: string };

// Interpret the `logo` / `logoType` fields of a create/update request body.
export function parseLogoUpload(logo: unknown, logoType: unknown): LogoUpdate {
  if (logo === undefined) return { action: "keep" };
  if (logo === null || logo === "") return { action: "clear" };
  if (typeof logo !== "string") return { action: "error", error: "invalid_logo" };
  if (typeof logoType !== "string" || !ALLOWED_LOGO_TYPES.has(logoType)) {
    return { action: "error", error: "invalid_logo_type" };
  }
  // Accept a raw base64 string or a data: URL (strip the "data:...;base64," prefix).
  const comma = logo.indexOf(",");
  const b64 = logo.startsWith("data:") && comma >= 0 ? logo.slice(comma + 1) : logo;
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return { action: "error", error: "invalid_logo" };
  if (buf.length > MAX_LOGO_BYTES) return { action: "error", error: "logo_too_large" };
  // Copy into a plain ArrayBuffer-backed Uint8Array so it satisfies Prisma's
  // Bytes type (Uint8Array<ArrayBuffer>), not Buffer<ArrayBufferLike>.
  const data = new Uint8Array(buf.length);
  data.set(buf);
  return { action: "set", data, type: logoType };
}
