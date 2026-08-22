/**
 * Portable AES-256-GCM helpers built on the standard Web Crypto API (`crypto.subtle`),
 * available with zero compatibility flags in Bun, Node 19+, and Cloudflare Workers.
 * Used to encrypt user-supplied burner-wallet private keys at rest, whether they land
 * in a local JSONL file or a Supabase row.
 */

export type EncryptedSecret = { iv: string; data: string };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseEncryptionKey(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("AUTO_MINT_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with `openssl rand -hex 32`.");
  }
  return hexToBytes(hex);
}

function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyBytes: Uint8Array): Promise<EncryptedSecret> {
  const key = await importKey(keyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv: bytesToHex(iv), data: bytesToHex(new Uint8Array(ciphertext)) };
}

export async function decryptSecret(enc: EncryptedSecret, keyBytes: Uint8Array): Promise<string> {
  const key = await importKey(keyBytes);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(enc.iv) as BufferSource }, key, hexToBytes(enc.data) as BufferSource);
  return new TextDecoder().decode(plaintext);
}
