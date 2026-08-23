import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { JsonlDropStatusStore } from "../src/discovery/rpc/drop-status";
import type { DropStatus } from "../src/domain/types";

const PATH = "/tmp/claude-0/-home-user-Orbis/c22c8a12-0df4-579a-bc03-d1a56b9b1def/scratchpad/drop-status-test.json";

function status(overrides: Partial<DropStatus> = {}): DropStatus {
  return {
    id: "ethereum:0x0000000000000000000000000000000000000010",
    chainKey: "ethereum",
    nftContract: "0x0000000000000000000000000000000000000010",
    source: "seadrop",
    status: "live_free",
    mintPriceWei: "0",
    startTime: 1000,
    endTime: 2000,
    maxTotalMintableByWallet: 5,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("JsonlDropStatusStore", () => {
  beforeEach(async () => { await rm(PATH, { force: true }); });
  afterEach(async () => { await rm(PATH, { force: true }); });

  test("saves and lists a status", async () => {
    const store = new JsonlDropStatusStore(PATH);
    const s = status();
    await store.save(s);
    expect(await store.list()).toEqual([s]);
  });

  test("returns an empty list when nothing has been saved yet", async () => {
    const store = new JsonlDropStatusStore(PATH);
    expect(await store.list()).toEqual([]);
  });

  test("overwrites the previous entry for the same id instead of accumulating duplicates", async () => {
    const store = new JsonlDropStatusStore(PATH);
    await store.save(status({ status: "upcoming" }));
    await store.save(status({ status: "live_free" }));
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0].status).toBe("live_free");
  });

  test("keeps separate entries for different ids", async () => {
    const store = new JsonlDropStatusStore(PATH);
    await store.save(status({ id: "ethereum:0xaaa", nftContract: "0x00000000000000000000000000000000000aaa" }));
    await store.save(status({ id: "ethereum:0xbbb", nftContract: "0x00000000000000000000000000000000000bbb" }));
    expect((await store.list()).length).toBe(2);
  });
});
