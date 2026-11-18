import { NextResponse, type NextRequest } from "next/server";

// NOTE: SESSION_COOKIE is NOT imported here from @/lib/auth/session — that
// module drags in the db.ts (Prisma) and tokens.ts (@node-rs/argon2 native
// binding) chain; since middleware runs on the Edge runtime, that breaks the
// build (node:url / argon2 wasm export errors). We keep the constant as a
// literal here; it must stay in sync with the value in session.ts ("ca_session").
const SESSION_COOKIE = "ca_session";
const SUPPORT_COOKIE = "ca_support"; // platform support session on a tenant host (see lib/support/session.ts)

const PROTECTED = ["/settings", "/admin"]; // under (app)
const PUBLIC = ["/login", "/recover", "/setup", "/invite", "/reset", "/api/auth", "/api/health"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/")) || pathname.startsWith("/_next")) {
    return NextResponse.next();
  }
  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value || !!req.cookies.get(SUPPORT_COOKIE)?.value;
  if (PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/")) && !hasSession) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
