import { randomBytes } from "node:crypto";
import { sha256 } from "@/lib/auth/tokens";

// No 0/o, 1/l/i: the ticket may be read off a screen and typed.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A connection ticket: 24 characters, about 118 bits; it starts connections for hours. */
export function newDbTicket(): string {
  const b = randomBytes(24);
  let s = "";
  for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return s;
}

/** Tickets are stored hashed: the database row alone opens nothing. */
export function dbTicketHash(ticket: string): string {
  return sha256(ticket.trim().toLowerCase());
}
