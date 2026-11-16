import { describe, expect, it } from "vitest";
import { isSealedValue, isVaultPublicKey, sealSecret, targetAAD, SEALED_PREFIX } from "./seal";

const subtle = globalThis.crypto.subtle;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

// The connector's side (connector/vault.go), in WebCrypto, to check the format.
async function open(priv: CryptoKey, pubRaw: Uint8Array, sealed: string, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = Uint8Array.from(Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64"));
  const eph = await subtle.importKey("raw", raw.slice(0, 32), { name: "X25519" }, false, []);
  const shared = await subtle.deriveBits({ name: "X25519", public: eph } as unknown as AlgorithmIdentifier, priv, 256);
  const salt = new Uint8Array([...raw.slice(0, 32), ...pubRaw]);
  const base = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("captivo-access vault v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(32, 44), additionalData: aad }, key, raw.slice(44));
  return new TextDecoder().decode(pt);
}

async function connectorKey() {
  const kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pubRaw, pub: b64(pubRaw) };
}

describe("vault sealing", () => {
  it("seals a secret that only the connector's key opens, for its target", async () => {
    const k = await connectorKey();
    const target = { host: " 10.0.0.5 ", port: 3389, username: "Administratör " };
    const sealed = await sealSecret(k.pub, "Pässwörd,;.", target);
    expect(isSealedValue(sealed)).toBe(true);
    expect(sealed).not.toContain("Pässwörd");
    expect(await open(k.priv, k.pubRaw, sealed, targetAAD(target))).toBe("Pässwörd,;.");
    // Another host, port or user: does not open.
    for (const other of [{ ...target, host: "10.0.0.6" }, { ...target, port: 3390 }, { ...target, username: "guest" }]) {
      await expect(open(k.priv, k.pubRaw, sealed, targetAAD(other))).rejects.toThrow();
    }
    // Another connector: does not open.
    const k2 = await connectorKey();
    await expect(open(k2.priv, k2.pubRaw, sealed, targetAAD(target))).rejects.toThrow();
  });

  it("binds the target exactly as the data-plane sends it (trimmed, code-point lengths)", () => {
    expect(new TextDecoder().decode(targetAAD({ host: " h ", port: 22, username: "ü" }))).toBe("6.target,1.h,2.22,1.ü;");
  });

  it("each seal is fresh", async () => {
    const k = await connectorKey();
    const t = { host: "h", port: 22, username: "u" };
    expect(await sealSecret(k.pub, "x", t)).not.toBe(await sealSecret(k.pub, "x", t));
  });

  it("accepts only well-formed keys and sealed values", async () => {
    const k = await connectorKey();
    expect(isVaultPublicKey(k.pub)).toBe(true);
    expect(isVaultPublicKey("")).toBe(false);
    expect(isVaultPublicKey(b64(new Uint8Array(31)))).toBe(false);
    expect(isVaultPublicKey(k.pub + "\nx")).toBe(false);
    expect(isSealedValue("plain")).toBe(false);
    expect(isSealedValue(SEALED_PREFIX + "AAAA")).toBe(false);
    expect(isSealedValue(SEALED_PREFIX + "%%%")).toBe(false);
  });
});
