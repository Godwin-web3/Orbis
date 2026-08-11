import { describe, expect, test } from "bun:test";
import { RuleClassifier } from "../src/core/classifier";
import { DefaultOpportunityEngine } from "../src/core/opportunity";
import { FixtureSimulator } from "../src/simulation/fixture";
import { DefaultPolicyEngine } from "../src/execution/policy";
import type { MintCandidate } from "../src/domain/types";

const base = (id: string, metadata: MintCandidate["metadata"]): MintCandidate => ({ id, chainKey: "base", contract: `0x${id.padEnd(40, "0").slice(0, 40)}` as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "freeMint", calldata: "0x1234", valueWei: 0n, metadata });

async function evaluate(candidate: MintCandidate) {
  const simulation = await new FixtureSimulator().simulate(candidate);
  const classification = await new RuleClassifier().classify(candidate, simulation);
  const opportunity = await new DefaultOpportunityEngine().score(candidate, classification, simulation);
  const decision = await new DefaultPolicyEngine().evaluate(opportunity, simulation);
  return { classification, simulation, opportunity, decision };
}

describe("nasty contract fixtures", () => {
  test("free mint with NFT receipt passes", async () => expect((await evaluate(base("a", { assetType: "nft", estimatedValueNative: 0.02 }))).decision.allowed).toBe(true));
  test("approval is rejected", async () => expect((await evaluate(base("b", { assetType: "nft", estimatedValueNative: 0.02, approval: true }))).decision.reasons).toContain("simulation produced token approval"));
  test("unexpected ETH transfer is rejected", async () => expect((await evaluate(base("c", { assetType: "nft", estimatedValueNative: 0.02, unexpectedEthTransfer: true }))).decision.reasons).toContain("simulation produced unexpected external value transfer"));
  test("revert is rejected", async () => expect((await evaluate(base("d", { assetType: "nft", estimatedValueNative: 0.02, simulation: "revert" }))).simulation.success).toBe(false));
  test("low EV is rejected by policy", async () => expect((await evaluate(base("e", { assetType: "nft", estimatedValueNative: 0.0001, gasEstimate: 800000 }))).decision.reasons).toContain("expected value is below configured threshold"));
  test("ERC20 fee is not free", async () => expect((await evaluate(base("f", { assetType: "nft", estimatedValueNative: 0.02, erc20Fee: true }))).classification.paymentKind).toBe("erc20"));
});
