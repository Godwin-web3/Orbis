import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { compileLab } from "../lab/compiler";
import { startLab } from "../lab/runtime";
import { LocalSnapshotSimulator } from "../src/simulation/snapshot";
import { RuleClassifier } from "../src/core/classifier";
import { DefaultOpportunityEngine } from "../src/core/opportunity";
import { DefaultPolicyEngine } from "../src/execution/policy";
import type { ContractArtifact } from "../lab/compiler";
import type { MintCandidate } from "../src/domain/types";

let artifacts: Record<string, ContractArtifact>;
let lab: Awaited<ReturnType<typeof startLab>>;
let nft: Address;
let token: Address;
let burn: Address;
let wallet: Address;
let sink: Address;

async function candidateFor(contract: Address, metadata: Record<string, string | number | boolean> = {}): Promise<MintCandidate> {
  return { id: `lab:${contract}:${Math.random()}`, chainKey: "lab", contract, source: "fork-lab", discoveredAt: new Date().toISOString(), mintFunction: "mint", calldata: "0x1249c58b", valueWei: 0n, from: wallet, metadata: { assetType: "nft", estimatedValueNative: 0.02, ...metadata } };
}

async function evaluate(candidate: MintCandidate) {
  const rpc = new LocalSnapshotSimulator(async (method, params) => lab.publicClient.request({ method: method as any, params: params as any }), [wallet, nft, token, burn, sink]);
  const simulation = await rpc.simulate(candidate);
  const classification = await new RuleClassifier().classify(candidate, simulation);
  const opportunity = await new DefaultOpportunityEngine().score(candidate, classification, simulation);
  const decision = await new DefaultPolicyEngine().evaluate(opportunity, simulation);
  return { simulation, classification, opportunity, decision };
}

async function configure(options: { start?: bigint; end?: bigint; feeToken?: Address; burnToken?: Address; drain?: boolean; approval?: boolean; burnRequired?: boolean; amount?: bigint; recipient?: Address } = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "configure", args: [options.start ?? now - 10n, options.end ?? now + 3600n, options.feeToken ?? "0x0000000000000000000000000000000000000000", options.burnToken ?? "0x0000000000000000000000000000000000000000", options.drain ?? false, options.approval ?? false, options.burnRequired ?? false, options.recipient ?? wallet, options.amount ?? 0n] });
}

beforeAll(async () => {
  artifacts = await compileLab();
  lab = await startLab(artifacts, { port: 8548 });
  wallet = lab.deployer.address;
  nft = await lab.deploy("LabNFT");
  token = await lab.deploy("LabERC20", [wallet, 10n]);
  burn = await lab.deploy("LabBurnToken", [wallet]);
  sink = await lab.deploy("LabSink");
});

afterAll(async () => { await lab.close(); });

describe("fork-backed adversarial lab", () => {
  test("legitimate free mint passes with traced NFT receipt", async () => {
    await configure();
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.success).toBe(true);
    expect(result.simulation.stateDiffAvailable).toBe(true);
    expect(result.simulation.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "in")).toBe(true);
    expect(result.decision.allowed).toBe(true);
  });

  test("ERC20 fee is rejected despite zero native value", async () => {
    await lab.wallet.writeContract({ address: token, abi: artifacts.LabERC20.abi, functionName: "approve", args: [nft, 10n] });
    await configure({ feeToken: token });
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.assetDiff.some((diff) => diff.kind === "erc20" && diff.direction === "out")).toBe(true);
    expect(result.classification.paymentKind).toBe("erc20");
    expect(result.decision.allowed).toBe(false);
  });

  test("quota exhaustion reverts", async () => {
    await configure();
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 0n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toContain("quota exhausted");
    expect(result.decision.allowed).toBe(false);
  });

  test("burn-to-mint is rejected as an NFT outflow", async () => {
    await configure({ burnToken: burn, burnRequired: true });
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "out")).toBe(true);
    expect(result.classification.paymentKind).toBe("nft-burn");
    expect(result.decision.allowed).toBe(false);
  });

  test("closed mint window reverts before broadcast", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    await configure({ start: now - 100n, end: now - 1n });
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toContain("window closed");
  });

  test("approval side effect is rejected", async () => {
    await configure({ approval: true });
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.approvalDiff.length).toBeGreaterThan(0);
    expect(result.decision.allowed).toBe(false);
  });

  test("native drain side effect is rejected", async () => {
    await lab.wallet.sendTransaction({ to: nft, value: 1n });
    await configure({ drain: true, amount: 1n, recipient: sink });
    await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [wallet, 1n] });
    const result = await evaluate(await candidateFor(nft));
    expect(result.simulation.unexpectedCalls?.length).toBeGreaterThan(0);
    expect(result.decision.allowed).toBe(false);
  });

  test("proxy implementation is visible at the EVM boundary", async () => {
    const proxy = await lab.deploy("LabProxy", [nft]);
    const publicClient = createPublicClient({ chain: { id: 31337, name: "Mint Lab", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8548"] } } }, transport: http("http://127.0.0.1:8548") });
    const implementation = await publicClient.readContract({ address: proxy, abi: artifacts.LabProxy.abi, functionName: "implementation" });
    expect((implementation as Address).toLowerCase()).toBe(nft.toLowerCase());
  });
});
