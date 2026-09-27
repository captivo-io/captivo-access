export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
};

export type TransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
};

/**
 * Ceilings for the CUSTOMER's mail relay. nodemailer applies none by default, so a
 * relay that accepts the connection and then goes quiet held the send open with no
 * end -- and every send here happens on a request path (an invite, a grant
 * decision, an access request), so the person waiting had no end either.
 *
 * Three separate limits because there are three separate ways to hang: the TCP
 * connect, the SMTP greeting, and any later exchange.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

export function buildTransportOptions(cfg: SmtpSettings): TransportOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}
