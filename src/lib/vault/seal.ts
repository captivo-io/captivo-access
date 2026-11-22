// Sealing a resource secret to a connector's vault key. Runs in the admin's
// browser (so the cloud only ever stores what it cannot open) and on the server
// for secrets that predate it (migration). Only the connector holding the
// private half can open the result: connector/vault.go is the other side of
// this format, and the two must change together.
//
//   "cv1:" + base64(ephemeral X25519 public (32) | nonce (12) | AES-256-GCM ciphertext+tag)
//
// key = HKDF-SHA256(X25519(eph, connector), salt = eph pub | connector pub,
// info = "captivo-access vault v1"). The additional data is the target, as the
// Guacamole instruction "target,<host>,<port>,<username>;": the connector opens
// a secret only for the values in the connect instruction actually sent to
// guacd, so it cannot be pointed at another machine.

export const SEALED_PREFIX = "cv1:";
const INFO = "captivo-access vault v1";

export type VaultTarget = { host: string; port: number; username: string };

export function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

// A connector's public key as it reports it: base64 of 32 bytes.
export function isVaultPublicKey(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(v)) return false;
  return fromB64(v).length === 32;
}

function guacElement(s: string): string {
  return `${Array.from(s).length}.${s}`;
}

// Must equal the values the data-plane puts in the connect instruction
// (dataplane/guacproto.go buildConnect): trimmed host and username, decimal port.
// A reconcile account (password rotation) is sealed for "reconcile,...": the
// connector opens it only inside a rotation, never for a session.
export type SealPurpose = "target" | "reconcile";

export function targetAAD(t: VaultTarget, purpose: SealPurpose = "target"): Uint8Array<ArrayBuffer> {
  const elems = [purpose, t.host.trim(), String(t.port), t.username.trim()];
  return new TextEncoder().encode(elems.map(guacElement).join(",") + ";");
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function buf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export async function sealSecret(connectorPublicKey: string, secret: string, target: VaultTarget, purpose: SealPurpose = "target"): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("vault_unsupported_browser");
  const recipientRaw = fromB64(connectorPublicKey);
  const recipient = await subtle.importKey("raw", buf(recipientRaw), { name: "X25519" }, false, []);
  const eph = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const shared = await subtle.deriveBits({ name: "X25519", public: recipient } as unknown as AlgorithmIdentifier, eph.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephRaw, 0);
  salt.set(recipientRaw, 32);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(new TextEncoder().encode(INFO)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(targetAAD(target, purpose)) }, key, buf(new TextEncoder().encode(secret))),
  );
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(ephRaw, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return SEALED_PREFIX + toB64(out);
}

// Shape check for a sealed value arriving from a browser (it cannot be opened
// here, by design).
export function isSealedValue(v: unknown): v is string {
  if (typeof v !== "string" || !isSealed(v) || v.length > 64 * 1024) return false;
  const body = v.slice(SEALED_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
  return fromB64(body).length >= 32 + 12 + 16;
}

// Showing a saved password to an admin (password rotation's "Reveal"): the
// browser makes a key pair for this one look, the connector seals the password
// to its public half, and only this page can open the result.
export async function revealKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("vault_unsupported_browser");
  const pair = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: toB64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))) };
}

export async function openSealedSecret(own: { privateKey: CryptoKey; publicKey: string }, sealed: string, target: VaultTarget): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  if (!isSealedValue(sealed)) throw new Error("not_sealed");
  const raw = fromB64(sealed.slice(SEALED_PREFIX.length));
  const ephRaw = raw.slice(0, 32);
  const nonce = raw.slice(32, 44);
  const ct = raw.slice(44);
  const eph = await subtle.importKey("raw", buf(ephRaw), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, own.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephRaw, 0);
  salt.set(fromB64(own.publicKey), 32);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(new TextEncoder().encode(INFO)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(targetAAD(target)) }, key, buf(ct));
  return new TextDecoder().decode(pt);
}
