import { describe, expect, test } from "bun:test";
import { JsonlUserRegistry } from "../src/users/registry";

describe("JsonlUserRegistry", () => {
  const path = `/tmp/fme-users-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  test("registers a valid address and returns it for the chat", async () => {
    const registry = new JsonlUserRegistry(path);
    const address = "0x0000000000000000000000000000000000000001";
    const user = await registry.register("12345", address as `0x${string}`);
    expect(user.address).toBe(address);
    expect(await registry.addressFor("12345")).toBe(address);
  });
  test("rejects an invalid address", async () => {
    const registry = new JsonlUserRegistry(path);
    await expect(registry.register("12345", "not-an-address" as `0x${string}`)).rejects.toThrow(/Invalid address/);
  });
  test("latest registration wins for a chat", async () => {
    const registry = new JsonlUserRegistry(path);
    const a = "0x0000000000000000000000000000000000000001";
    const b = "0x0000000000000000000000000000000000000002";
    await registry.register("777", a as `0x${string}`);
    await registry.register("777", b as `0x${string}`);
    expect(await registry.addressFor("777")).toBe(b);
  });
  test("returns undefined for an unknown chat", async () => {
    const registry = new JsonlUserRegistry(path);
    expect(await registry.addressFor("missing")).toBeUndefined();
  });
});
