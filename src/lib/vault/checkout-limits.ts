// The length of a password check-out, in minutes (see checkout.ts).

export const CHECKOUT_MIN_MINUTES = 15;
export const CHECKOUT_MAX_MINUTES = 1440;
export const CHECKOUT_DEFAULT_MINUTES = 240;

/** A length in minutes within the limits, or null. */
export function validCheckoutMinutes(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= CHECKOUT_MIN_MINUTES && n <= CHECKOUT_MAX_MINUTES ? n : null;
}
