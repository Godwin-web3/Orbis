import { describe, expect, test } from "bun:test";
import { isSpamName, scoreMintValue } from "../src/discovery/value/score";
import { CollectionValueOracle } from "../src/discovery/value/oracle";
import type { MintCandidate } from "../src/domain/types";

describe("isSpamName", () => {
  test("flags empty and generic names", () => {
    expect(isSpamName(undefined)).toBe(true);
    expect(isSpamName("")).toBe(true);
    expect(isSpamName("Test Collection")).toBe(true);
    expect(isSpamName("Untitled")).toBe(true);
    expect(isSpamName("0xabc123")).toBe(true);
  });
  test("keeps real names", () => {
    expect(isSpamName("Pudgy Penguins")).toBe(false);
    expect(isSpamName("Based Fellas")).toBe(false);
  });
});

describe("scoreMintValue", () => {
  test("a silent free mint with no floor is junk", () => {
    const scored = scoreMintValue({ name: "Random Drop", recentMints: 0 });
    expect(scored.hasSignal).toBe(false);
    expect(scored.estimatedValueNative).toBe(0);
    expect(scored.valueScore).toBeLessThan(20);
  });

  test("live demand without a floor still counts — that's a hot new drop", () => {
    const scored = scoreMintValue({ name: "Based Fellas", recentMints: 12 });
    expect(scored.hasSignal).toBe(true);
    expect(scored.valueScore).toBeGreaterThanOrEqual(20);
  });

  test("a real floor becomes a conservative estimated value", () => {
    const scored = scoreMintValue({ name: "Pudgy Penguins", floorNative: 0.05, volumeAllTimeNative: 2, ownerCount: 400, verified: true });
    expect(scored.hasSignal).toBe(true);
    expect(scored.estimatedValueNative).toBeCloseTo(0.02);
    expect(scored.valueScore).toBeGreaterThanOrEqual(40);
  });

  test("a week-old silent mint is crushed even if it had a tiny score", () => {
    const scored = scoreMintValue({ name: "Whatever", recentMints: 0, openedAgoSeconds: 10 * 86400 });
    expect(scored.hasSignal).toBe(false);
    expect(scored.valueScore).toBeLessThanOrEqual(5);
  });
});

describe("CollectionValueOracle", () => {
  const candidate = (): MintCandidate => ({
    id: "ethereum:seadrop:0x00000000000000000000000000000000000000aa",
    chainKey: "ethereum",
    contract: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
    source: "seadrop",
    discoveredAt: new Date().toISOString(),
    mintFunction: "mintPublic",
    calldata: "0x1234",
    valueWei: 0n,
    metadata: { assetType: "nft", seadrop: true, nftContract: "0x00000000000000000000000000000000000000aa", recentMints: 1 },
  });

  test("writes floor and estimated value from Reservoir", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        collections: [{
          name: "Cool Cats",
          ownerCount: "80",
          tokenCount: "200",
          twitterUsername: "coolcats",
          openseaVerificationStatus: "verified",
          volume: { allTime: 1.2 },
          floorAsk: { price: { amount: { native: 0.04 } } },
        }],
      }),
    })) as unknown as typeof fetch;
    const enriched = await new CollectionValueOracle(fetchImpl).enrich(candidate());
    expect(enriched.metadata.floorNative).toBe(0.04);
    expect(enriched.metadata.estimatedValueNative).toBe(0.016);
    expect(enriched.metadata.valueSignal).toBe(true);
    expect(enriched.metadata.name).toBe("Cool Cats");
  });

  test("survives a dead oracle without throwing", async () => {
    const fetchImpl = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const enriched = await new CollectionValueOracle(fetchImpl).enrich(candidate());
    expect(enriched.metadata.valueSignal).toBe(false);
    expect(enriched.metadata.estimatedValueNative).toBe(0);
  });
});
