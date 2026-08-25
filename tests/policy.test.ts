import { describe, expect, test } from "bun:test";
import { DefaultPolicyEngine } from "../src/execution/policy";
import type { MintCandidate, Opportunity, SimulationResult } from "../src/domain/types";

function candidate(overrides: Partial<MintCandidate> = {}): MintCandidate {
  return { id: "c1", chainKey: "ethereum", contract: "0x0000000000000000000000000000000000000001", source: "test", discoveredAt: new Date().toISOString(), valueWei: 0n, metadata: { assetType: "nft", floorNative: 0.02, estimatedValueNative: 0.008 }, ...overrides };
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    candidate: candidate(),
    classification: { isNft: true, isMintOrClaim: true, isFree: true, isActive: true, isEligible: true, paymentKind: "none", reasons: [] },
    probability: 1,
    estimatedValueNative: 0.02,
    gasNative: 0.001,
    executionRisk: 0,
    expectedValueNative: 0.019,
    priority: 1,
    ...overrides,
  };
}

function simulation(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return { success: true, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], ...overrides };
}

describe("DefaultPolicyEngine", () => {
  test("rejects a generic (non-SeaDrop) candidate whose simulation didn't show an NFT receipt", async () => {
    const decision = await new DefaultPolicyEngine().evaluate(opportunity(), simulation());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("simulation did not show NFT receipt");
  });

  test("allows a generic candidate once the trace-derived assetDiff shows an incoming NFT", async () => {
    const sim = simulation({ stateDiffAvailable: true, assetDiff: [{ kind: "nft", direction: "in" }] });
    const decision = await new DefaultPolicyEngine().evaluate(opportunity(), sim);
    expect(decision.allowed).toBe(true);
  });

  test("allows a SeaDrop candidate on a successful simulation even with no trace-derived assetDiff (free RPC providers don't support debug_traceCall)", async () => {
    const opp = opportunity({ candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true, recentMints: 8 } }) });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(true);
  });

  test("still rejects a SeaDrop candidate if the simulation itself failed", async () => {
    const opp = opportunity({ candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true, recentMints: 8 } }) });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation({ success: false, revertReason: "reverted" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("reverted");
  });

  test("rejects a live-free SeaDrop with no floor and no demand — that's the trash /scan used to dump", async () => {
    const opp = opportunity({
      candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true } }),
      estimatedValueNative: 0,
      expectedValueNative: -0.001,
    });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("no demand or floor — likely worthless");
  });

  test("allows a no-floor drop when people are actually minting it", async () => {
    const opp = opportunity({
      candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true, recentMints: 9 } }),
      estimatedValueNative: 0,
      expectedValueNative: -0.001,
    });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(true);
  });

  test("allows a quiet drop when a marketplace floor exists", async () => {
    const opp = opportunity({
      candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true, floorNative: 0.02, estimatedValueNative: 0.008 } }),
      estimatedValueNative: 0.008,
      expectedValueNative: 0.007,
    });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(true);
  });

  test("still rejects when a real value estimate was supplied and gas eats the expected value below threshold", async () => {
    const opp = opportunity({
      candidate: candidate({ metadata: { assetType: "nft", estimatedValueNative: 0.0001 } }),
      estimatedValueNative: 0,
      expectedValueNative: -0.001,
    });
    const sim = simulation({ stateDiffAvailable: true, assetDiff: [{ kind: "nft", direction: "in" }] });
    const decision = await new DefaultPolicyEngine().evaluate(opp, sim);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("expected value is below configured threshold");
  });
});
