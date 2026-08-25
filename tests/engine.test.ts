import { describe, expect, test } from "bun:test";
import { RuleClassifier } from "../src/core/classifier";
import { DefaultOpportunityEngine } from "../src/core/opportunity";
import { FixtureSimulator } from "../src/simulation/fixture";
import { DefaultPolicyEngine } from "../src/execution/policy";
import { MintEngine } from "../src/app/engine";
import type { CandidateStore, ContractInspector, NotificationSink } from "../src/domain/ports";
import type { MintCandidate } from "../src/domain/types";

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
    // Above MAX_LAUNCHPAD_PRICE_NATIVE's default cap (0.001 ETH) — genuinely not "cheap enough to treat as free".
    const candidate = { id: "demo-2", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "mint", calldata: "0x1234" as `0x${string}`, valueWei: 10n ** 16n, metadata: { assetType: "nft" } };
    const classification = await new RuleClassifier().classify(candidate);
    expect(classification.isFree).toBe(false);
    expect(classification.reasons).toContain("payment required");
  });

  test("processOne notifies without throwing on a real candidate (regression: raw bigint fields broke JSON.stringify)", async () => {
    const candidate: MintCandidate = { id: "demo-3", chainKey: "base", contract: "0x0000000000000000000000000000000000000001", source: "test", discoveredAt: new Date().toISOString(), mintFunction: "mint", calldata: "0x1234", valueWei: 0n, active: true, eligible: true, metadata: { assetType: "nft", estimatedValueNative: 0.02, gasPriceGwei: 1 } };
    const sent: string[] = [];
    const notifications: NotificationSink = { send: async (message) => { sent.push(message); } };
    const store: CandidateStore = { save: async () => {}, list: async () => [] };
    const engine = new MintEngine({
      sources: [],
      classifier: new RuleClassifier(),
      opportunities: new DefaultOpportunityEngine(),
      simulator: new FixtureSimulator(),
      policy: new DefaultPolicyEngine(),
      store,
      notifications,
    });

    await engine.processOne(candidate);

    expect(sent.length).toBe(1);
    // Must actually be valid JSON, and any bigint field (candidate.valueWei) must have
    // survived as a string, not thrown "Do not know how to serialize a BigInt".
    const parsed = JSON.parse(sent[0]);
    expect(parsed.candidate.valueWei).toBe("0");
  });

  test("skips the generic inspector chain for a self-sufficient candidate that already has calldata (regression: SeaDrop candidates were burning ~9 wasted RPC calls each via EvmEligibilityInspector, checking the wrong contract, blowing Cloudflare's 50-subrequest budget)", async () => {
    let inspectCalls = 0;
    const inspector: ContractInspector = { inspect: async (candidate) => { inspectCalls++; return candidate; } };
    const candidate: MintCandidate = { id: "demo-4", chainKey: "ethereum", contract: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5", source: "seadrop", discoveredAt: new Date().toISOString(), mintFunction: "mintPublic", calldata: "0x1234", valueWei: 0n, active: true, eligible: true, metadata: { assetType: "nft", seadrop: true } };
    const store: CandidateStore = { save: async () => {}, list: async () => [] };
    const engine = new MintEngine({
      sources: [],
      classifier: new RuleClassifier(),
      opportunities: new DefaultOpportunityEngine(),
      simulator: new FixtureSimulator(),
      policy: new DefaultPolicyEngine(),
      store,
      notifications: { send: async () => {} },
      inspector,
    });

    await engine.processOne(candidate);
    expect(inspectCalls).toBe(0);
  });

  test("still runs the inspector chain for a candidate discovered without calldata", async () => {
    let inspectCalls = 0;
    const inspector: ContractInspector = { inspect: async (candidate) => { inspectCalls++; return candidate; } };
    const candidate: MintCandidate = { id: "demo-5", chainKey: "base", contract: "0x0000000000000000000000000000000000000001", source: "block-contracts", discoveredAt: new Date().toISOString(), mintFunction: "mint", valueWei: 0n, metadata: { assetType: "nft" } };
    const store: CandidateStore = { save: async () => {}, list: async () => [] };
    const engine = new MintEngine({
      sources: [],
      classifier: new RuleClassifier(),
      opportunities: new DefaultOpportunityEngine(),
      simulator: new FixtureSimulator(),
      policy: new DefaultPolicyEngine(),
      store,
      notifications: { send: async () => {} },
      inspector,
      calldata: { build: async (c) => ({ chainKey: c.chainKey, to: c.contract, data: "0xabcd" as `0x${string}`, value: c.valueWei }) },
    });

    await engine.processOne(candidate);
    expect(inspectCalls).toBe(1);
  });
});
