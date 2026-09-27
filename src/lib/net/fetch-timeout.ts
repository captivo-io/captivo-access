/**
 * Outbound HTTP with a bounded wait.
 *
 * Node's `fetch` applies NO timeout of its own: a request to a host that accepts
 * the connection and then says nothing waits forever. Everything this product
 * calls out to is someone else's machine -- a connector on a customer's network,
 * their identity provider, their mail server -- so every such call needs its own
 * ceiling, chosen where the call is made.
 *
 * Until now the ceiling was an accident. Cloud requests run inside a tenant scope,
 * which is a database transaction with a budget, so the transaction expiring was
 * what ended an unbounded wait -- as a P2028 naming a Prisma model, nowhere near
 * the call that hung. Raising that budget (see lib/tenant/scope.ts) removes the
 * accident, which is why these ceilings have to be explicit.
 */

/** A request that must finish, body included, within `ms`. */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  return fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * A request whose HEADERS must arrive within `ms`, after which the body may stream
 * for as long as it needs.
 *
 * For downloads. `AbortSignal.timeout` would abort the transfer itself, so a
 * recording or a file bigger than the timeout could carry would be truncated
 * mid-stream -- and truncation reads as corruption, not as a timeout. The timer is
 * cleared the moment `fetch` resolves, which in Node is when the response head has
 * been received.
 */
export async function fetchStreamWithHeaderTimeout(
  input: string | URL,
  init: RequestInit & { headerTimeoutMs: number },
): Promise<Response> {
  const { headerTimeoutMs, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`no response head within ${headerTimeoutMs}ms`)), headerTimeoutMs);
  try {
    return await fetch(input, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
