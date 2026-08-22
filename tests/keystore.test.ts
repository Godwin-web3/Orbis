import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { JsonlUserKeyStore, parseEncryptionKey } from "../src/users/keystore";

const TEST_KEY = generatePrivateKey();
const TEST_ADDRESS = privateKeyToAccount(TEST_KEY).address;

function tmpPath(): string {
  return `/tmp/fme-keystore-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
}

describe("parseEncryptionKey", () => {
  test("accepts a 32-byte hex key", () => {
    expect(parseEncryptionKey("00".repeat(32)).length).toBe(32);
  });
  test("rejects a short or non-hex key", () => {
    expect(() => parseEncryptionKey("not-hex")).toThrow(/AUTO_MINT_ENCRYPTION_KEY/);
    expect(() => parseEncryptionKey("00".repeat(10))).toThrow(/AUTO_MINT_ENCRYPTION_KEY/);
  });
});

describe("JsonlUserKeyStore", () => {
  const encKey = parseEncryptionKey("11".repeat(32));

  test("stores a key encrypted at rest and decrypts it back correctly", async () => {
    const path = tmpPath();
    const store = new JsonlUserKeyStore(path, encKey);
    const address = await store.setKey("chat1", TEST_KEY);
    expect(address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(await store.hasKey("chat1")).toBe(true);
    expect(await store.getDecryptedKey("chat1")).toBe(TEST_KEY);

    const raw = await Bun.file(path).text();
    expect(raw).not.toContain(TEST_KEY.slice(2));
  });

  test("auto-mint is off by default and requires a key before enabling", async () => {
    const path = tmpPath();
    const store = new JsonlUserKeyStore(path, encKey);
    await expect(store.setAutoMint("chat2", true)).rejects.toThrow(/No burner wallet registered/);
    await store.setKey("chat2", TEST_KEY);
    expect(await store.isAutoMintEnabled("chat2")).toBe(false);
    await store.setAutoMint("chat2", true);
    expect(await store.isAutoMintEnabled("chat2")).toBe(true);
  });

  test("listEnabled only returns users with a key AND auto-mint on", async () => {
    const path = tmpPath();
    const store = new JsonlUserKeyStore(path, encKey);
    await store.setKey("a", TEST_KEY);
    await store.setKey("b", TEST_KEY);
    await store.setAutoMint("a", true);
    expect((await store.listEnabled()).map((u) => u.userId)).toEqual(["a"]);
  });

  test("removeKey disables auto-mint and clears the key", async () => {
    const path = tmpPath();
    const store = new JsonlUserKeyStore(path, encKey);
    await store.setKey("c", TEST_KEY);
    await store.setAutoMint("c", true);
    await store.removeKey("c");
    expect(await store.hasKey("c")).toBe(false);
    expect(await store.isAutoMintEnabled("c")).toBe(false);
    expect(await store.getDecryptedKey("c")).toBeUndefined();
  });

  test("setKey on re-registration resets auto-mint to off", async () => {
    const path = tmpPath();
    const store = new JsonlUserKeyStore(path, encKey);
    await store.setKey("d", TEST_KEY);
    await store.setAutoMint("d", true);
    await store.setKey("d", TEST_KEY);
    expect(await store.isAutoMintEnabled("d")).toBe(false);
  });
});
