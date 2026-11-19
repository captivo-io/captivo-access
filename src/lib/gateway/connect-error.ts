// What the vendor sees when guacd (or the tunnel) stops a gateway session.
// guacd sends a Guacamole status code plus its own short text, e.g. an RDP
// sign-in the target refused arrives as CLIENT_UNAUTHORIZED with
// "Authentication failure (invalid credentials?)". The code picks the wording;
// guacd's text is kept as the detail.

export interface SessionFailure { title: string; hint: string; detail: string | null }

// Guacamole.Status.Code values (guacamole-common-js).
const CODE = {
  SERVER_BUSY: 0x0201,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_CONFLICT: 0x0209,
  SESSION_TIMEOUT: 0x020a,
  SESSION_CLOSED: 0x020b,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
  CLIENT_TIMEOUT: 0x0308,
  CLIENT_TOO_MANY: 0x031d,
} as const;

const ASK_ADMIN = "Ask an administrator of this workspace to check the resource.";

export function sessionFailure(status: { code?: number; message?: string } | null | undefined): SessionFailure {
  const code = status?.code;
  const raw = status?.message?.trim();
  const detail = raw ? raw : null;
  const out = (title: string, hint: string): SessionFailure => ({ title, hint, detail });
  switch (code) {
    case CODE.CLIENT_UNAUTHORIZED:
      return out(
        "The computer rejected the sign-in",
        "The user name or password saved for this resource was not accepted. A domain account needs its domain, like DOMAIN\\user. " + ASK_ADMIN,
      );
    case CODE.CLIENT_FORBIDDEN:
      return out("The computer refused this sign-in", "The account may not be allowed to sign in remotely. " + ASK_ADMIN);
    case CODE.UPSTREAM_NOT_FOUND:
    case CODE.UPSTREAM_UNAVAILABLE:
    case CODE.UPSTREAM_ERROR:
      return out(
        "The computer could not be reached",
        "The connector could not open a session to it. It may be turned off, or its address, port or security settings may be wrong. " + ASK_ADMIN,
      );
    case CODE.UPSTREAM_TIMEOUT:
      return out("The computer did not answer in time", "It may be busy or turned off. Try again in a moment.");
    case CODE.SESSION_CONFLICT:
      return out("Someone else signed in", "Another connection took over this sign-in on the computer.");
    case CODE.SESSION_CLOSED:
      return out("The computer ended the session", "You were signed out on the computer, or it was restarted.");
    case CODE.SESSION_TIMEOUT:
      return out("The session timed out", "It was idle for too long.");
    case CODE.CLIENT_TIMEOUT:
      return out("The connection was lost", "Your browser stopped answering for too long. Check your network and try again.");
    case CODE.SERVER_BUSY:
    case CODE.CLIENT_TOO_MANY:
      return out("The gateway is busy", "Too many sessions are open right now. Try again in a moment.");
    default:
      return out("The session ended or could not start", "Try again. If it keeps happening, " + ASK_ADMIN.charAt(0).toLowerCase() + ASK_ADMIN.slice(1));
  }
}
