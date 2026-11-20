import { randomBytes } from "node:crypto";

// No 0/o, 1/l/i: the code may be read aloud or typed.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The jump host user name a command carries: 12 characters, about 59 bits. */
export function newSshTicketCode(): string {
  const b = randomBytes(12);
  let s = "";
  for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return s;
}
