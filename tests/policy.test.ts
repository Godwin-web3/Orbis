import { describe, expect, test } from "bun:test";
import { DefaultPolicyEngine } from "../src/execution/policy";
import type { MintCandidate, Opportunity, SimulationResult } from "../src/domain/types";

function candidate(overrides: Partial<MintCandidate> = {}): MintCandidate {
  return { id: "c1", chainKey: "ethereum", contract: "0x0000000000000000000000000000000000000001", source: "test", discoveredAt: new Date().toISOString(), valueWei: 0n, metadata: { assetType: "nft" }, ...overrides };
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
    const opp = opportunity({ candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true } }) });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(true);
  });

  test("still rejects a SeaDrop candidate if the simulation itself failed", async () => {
    const opp = opportunity({ candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true } }) });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation({ success: false, revertReason: "reverted" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("reverted");
  });

  test("allows a real-world candidate even though nothing populates metadata.estimatedValueNative (no price-oracle integration exists) — expectedValueNative is always <= 0 in that case, but there's no actual estimate to judge it by", async () => {
    const opp = opportunity({
      candidate: candidate({ source: "seadrop", metadata: { assetType: "nft", seadrop: true } }), // no estimatedValueNative key
      estimatedValueNative: 0,
      expectedValueNative: -0.001, // just -gasNative, as it always is without a value estimate
    });
    const decision = await new DefaultPolicyEngine().evaluate(opp, simulation());
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).not.toContain("expected value is below configured threshold");
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
