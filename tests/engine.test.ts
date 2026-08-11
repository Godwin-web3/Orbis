import { describe, expect, test } from "bun:test";
import { RuleClassifier } from "../src/core/classifier";
import { DefaultOpportunityEngine } from "../src/core/opportunity";
import { FixtureSimulator } from "../src/simulation/fixture";
import { DefaultPolicyEngine } from "../src/execution/policy";

describe("free mint pipeline", () => {
  test("accepts a simulated free NFT mint", async () => {
    const candidate = { id: "demo-1", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "mint", calldata: "0x1234" as `0x${string}`, valueWei: 0n, active: true, eligible: true, metadata: { assetType: "nft", estimatedValueNative: 0.02, gasPriceGwei: 1 } };
    const classification = await new RuleClassifier().classify(candidate);
    const simulation = await new FixtureSimulator().simulate(candidate);
    const opportunity = await new DefaultOpportunityEngine().score(candidate, classification, simulation);
    const decision = await new DefaultPolicyEngine().evaluate(opportunity, simulation);
    expect(decision.allowed).toBe(true);
  });

  test("rejects payment-required candidates", async () => {
    const candidate = { id: "demo-2", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "mint", calldata: "0x1234" as `0x${string}`, valueWei: 1n, metadata: { assetType: "nft" } };
    const classification = await new RuleClassifier().classify(candidate);
    expect(classification.isFree).toBe(false);
    expect(classification.reasons).toContain("payment required");
  });
});
