import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlCandidateStore } from "../src/storage/jsonl";
import { JsonlNotificationSink } from "../src/notifications/jsonl";

describe("observability persistence", () => {
  let dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  test("round-trips bigint candidates and appends events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mint-engine-")); dirs.push(dir);
    const candidate = { id: "x", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), valueWei: 123n, metadata: { assetType: "nft" } };
    const store = new JsonlCandidateStore(join(dir, "candidates.jsonl")); await store.save(candidate); expect((await store.list())[0]?.valueWei).toBe(123n);
    const events = new JsonlNotificationSink(join(dir, "events.jsonl")); await events.send('{"status":"PASS"}'); expect(await readFile(join(dir, "events.jsonl"), "utf8")).toContain("PASS");
  });
});
