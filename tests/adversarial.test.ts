import { describe, expect, test } from "bun:test";
import { RuleClassifier } from "../src/core/classifier";
import { DefaultOpportunityEngine } from "../src/core/opportunity";
import { FixtureSimulator } from "../src/simulation/fixture";
import { DefaultPolicyEngine } from "../src/execution/policy";

type Fixture = {
  id: string;
  calldata?: `0x${string}`;
  valueWei?: bigint;
  metadata: Record<string, string | number | boolean>;
  active?: boolean;
  eligible?: boolean;
};

const base = (overrides: Partial<Fixture> = {}) => ({
  id: "fixture",
  chainKey: "base",
  contract: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  source: "fixture",
  discoveredAt: new Date().toISOString(),
  mintFunction: "freeMint",
  calldata: "0x1234" as `0x${string}`,
  valueWei: 0n,
  active: true,
  eligible: true,
  metadata: { assetType: "nft", estimatedValueNative: 0.02, gasEstimate: 250000, gasPriceWei: 1000000000 },
  ...overrides,
});

async function evaluate(candidate: ReturnType<typeof base>) {
  const classification = await new RuleClassifier().classify(candidate);
  const simulation = await new FixtureSimulator().simulate(candidate);
  const opportunity = await new DefaultOpportunityEngine().score(candidate, classification, simulation);
  const decision = await new DefaultPolicyEngine().evaluate(opportunity, simulation);
  return { classification, simulation, opportunity, decision };
}

describe("adversarial simulation and policy fixtures", () => {
  test("free mint receives NFT: PASS", async () => {
    const result = await evaluate(base());
    expect(result.decision.allowed).toBe(true);
    expect(result.simulation.assetDiff).toHaveLength(1);
  });

  test("NFT plus unlimited approval: REJECT", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", estimatedValueNative: 0.02, approval: true } }));
    expect(result.simulation.approvalDiff).toHaveLength(1);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reasons).toContain("simulation produced token approval");
  });

  test("NFT plus unexpected ETH transfer: REJECT", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", estimatedValueNative: 0.02, unexpectedEthTransfer: true } }));
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reasons).toContain("simulation produced unexpected external value transfer");
  });

  test("revert: REJECT", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", simulation: "revert", revertReason: "sold out" } }));
    expect(result.simulation.success).toBe(false);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reasons).toContain("sold out");
  });

  test("high gas makes EV non-positive: SKIP", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", estimatedValueNative: 0.0001, gasEstimate: 1000000, gasPriceWei: 1000000000 } }));
    expect(result.opportunity.expectedValueNative).toBeLessThanOrEqual(0);
    expect(result.decision.allowed).toBe(false);
  });

  test("zero ETH but ERC-20 fee is not free", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", erc20Fee: true } }));
    expect(result.classification.isFree).toBe(false);
    expect(result.classification.reasons).toContain("wallet state transition requires erc20");
  });

  test("zero ETH but burn requirement is not free", async () => {
    const result = await evaluate(base({ metadata: { assetType: "nft", burnRequired: true } }));
    expect(result.classification.isFree).toBe(false);
  });
});
