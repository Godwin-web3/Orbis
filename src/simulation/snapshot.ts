import type { Simulator } from "../domain/ports";
import type { Address, AssetDiff, ExternalCall, MintCandidate, SimulationResult, StateDiff, TransactionRequest } from "../domain/types";
import { buildMintCalldata } from "../discovery/contract/detector";

type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;
type ReceiptLog = { address?: string; topics?: string[]; data?: string };
type TransactionReceipt = { status?: string; gasUsed?: string; logs?: ReceiptLog[] };
type BalanceMap = Record<string, bigint>;
type StorageSnapshot = { balances: BalanceMap; allowances: Map<string, bigint> };

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_FOR_ALL_TOPIC = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const BALANCE_OF_SELECTOR = "0x70a08231";
const ALLOWANCE_SELECTOR = "0xdd62ed3e";

function normalizeAddress(value: string | undefined): Address | undefined { return value?.toLowerCase() as Address | undefined; }
function quantity(value: string | undefined): bigint { if (!value) return 0n; try { return BigInt(value); } catch { return 0n; } }
function hex(value: bigint): string { return `0x${value.toString(16)}`; }
function padAddress(address: Address): string { return address.slice(2).padStart(64, "0"); }
function topicAddress(topic: string | undefined): Address | undefined { if (!topic || topic.length < 42) return undefined; return `0x${topic.slice(-40)}`.toLowerCase() as Address; }
function parseAmount(data: string | undefined): string | undefined { if (!data || data === "0x") return undefined; try { return BigInt(data).toString(); } catch { return undefined; } }

function decodeAssetDiff(logs: ReceiptLog[], wallet: Address): AssetDiff[] {
  const diffs: AssetDiff[] = [];
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || !log.address) continue;
    const from = topicAddress(topics[1]);
    const to = topicAddress(topics[2]);
    if (!from || !to) continue;
    const incoming = to === wallet;
    const outgoing = from === wallet;
    if (!incoming && !outgoing) continue;
    if (topics.length >= 4) diffs.push({ kind: "nft", direction: incoming ? "in" : "out", token: normalizeAddress(log.address), tokenId: quantity(topics[3]).toString() });
    else diffs.push({ kind: "erc20", direction: incoming ? "in" : "out", token: normalizeAddress(log.address), amount: parseAmount(log.data) });
  }
  return diffs;
}

function decodeApprovalDiff(logs: ReceiptLog[]) {
  return logs.flatMap((log) => {
    const topics = log.topics ?? [];
    if (!log.address || topics.length < 3) return [];
    const topic0 = topics[0]?.toLowerCase();
    if (topic0 !== APPROVAL_TOPIC && topic0 !== APPROVAL_FOR_ALL_TOPIC) return [];
    const owner = topicAddress(topics[1]);
    const spender = topicAddress(topics[2]);
    if (!owner || !spender) return [];
    return [{ token: normalizeAddress(log.address)!, owner, spender, amount: topic0 === APPROVAL_FOR_ALL_TOPIC ? (quantity(log.data) === 0n ? "0" : "unlimited") : quantity(log.data).toString() }];
  });
}

async function callQuantity(rpc: RpcRequest, to: Address, data: string): Promise<bigint | undefined> {
  try { return quantity(await rpc("eth_call", [{ to, data }, "latest"]) as string); } catch { return undefined; }
}

async function waitForReceipt(rpc: RpcRequest, hash: string): Promise<TransactionReceipt> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]) as TransactionReceipt | null;
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${hash}`);
}

export class LocalSnapshotSimulator implements Simulator {
  constructor(private readonly rpc: RpcRequest, private readonly watchAddresses: Address[]) {}

  private async nativeBalances(): Promise<BalanceMap> {
    const entries = await Promise.all(this.watchAddresses.map(async (address) => [address.toLowerCase(), quantity(await this.rpc("eth_getBalance", [address, "latest"]) as string)] as const));
    return Object.fromEntries(entries);
  }

  private async storageSnapshot(wallet: Address, candidate: Address): Promise<StorageSnapshot> {
    const balances = await this.nativeBalances();
    const allowances = new Map<string, bigint>();
    const owners = [wallet, candidate];
    const spenders = [wallet, candidate];
    await Promise.all(this.watchAddresses.filter((address) => address.toLowerCase() !== wallet).flatMap((token) => [
      (async () => {
        const value = await callQuantity(this.rpc, token, `${BALANCE_OF_SELECTOR}${padAddress(wallet)}`);
        if (value !== undefined) balances[`token:${token.toLowerCase()}:${wallet}`] = value;
      })(),
      ...owners.flatMap((owner) => spenders.map((spender) => (async () => {
        const value = await callQuantity(this.rpc, token, `${ALLOWANCE_SELECTOR}${padAddress(owner)}${padAddress(spender)}`);
        if (value !== undefined) allowances.set(`${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`, value);
      })())),
    ]));
    return { balances, allowances };
  }

  private stateDiffs(before: StorageSnapshot, after: StorageSnapshot): StateDiff[] {
    const diffs: StateDiff[] = [];
    for (const [key, value] of Object.entries(after.balances)) {
      const previous = before.balances[key];
      if (previous === undefined || previous === value) continue;
      const parts = key.split(":");
      diffs.push({ address: parts.length === 3 ? parts[1] as Address : key as Address, field: parts.length === 3 ? "balanceOf" : "nativeBalance", before: previous.toString(), after: value.toString(), kind: "balance", owner: parts.length === 3 ? parts[2] as Address : undefined });
    }
    for (const [key, value] of after.allowances) {
      const previous = before.allowances.get(key);
      if (previous === undefined || previous === value) continue;
      const [token, owner, spender] = key.split(":");
      diffs.push({ address: token as Address, field: "allowance", before: previous.toString(), after: value.toString(), kind: "allowance", owner: owner as Address, spender: spender as Address });
    }
    return diffs;
  }

  async simulate(candidate: MintCandidate, request?: TransactionRequest): Promise<SimulationResult> {
    const data = request?.data ?? candidate.calldata ?? buildMintCalldata(candidate);
    const wallet = normalizeAddress(request?.from ?? candidate.from);
    if (!data) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "unable to construct mint calldata" };
    if (!wallet) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "a simulation wallet is required" };
    const snapshot = await this.rpc("evm_snapshot", []) as string;
    const before = await this.storageSnapshot(wallet, candidate.contract);
    const tx = { from: wallet, to: candidate.contract, data, value: hex(request?.value ?? candidate.valueWei) };
    try {
      const gasPrice = quantity(await this.rpc("eth_gasPrice", []) as string);
      const gas = await this.rpc("eth_estimateGas", [tx]) as string;
      const hash = await this.rpc("eth_sendTransaction", [{ ...tx, gas }]) as string;
      const receipt = await waitForReceipt(this.rpc, hash);
      const after = await this.storageSnapshot(wallet, candidate.contract);
      const assetDiff = decodeAssetDiff(receipt.logs ?? [], wallet);
      const approvalDiff = decodeApprovalDiff(receipt.logs ?? []);
      const stateDiff = this.stateDiffs(before, after);
      const unexpectedCalls: ExternalCall[] = [];
      const externalValueTransfers: SimulationResult["externalValueTransfers"] = [];
      const expectedCandidateIn = request?.value ?? candidate.valueWei;
      for (const address of this.watchAddresses) {
        const key = address.toLowerCase();
        const delta = (after.balances[key] ?? 0n) - (before.balances[key] ?? 0n);
        const expected = key === wallet ? -(expectedCandidateIn + quantity(receipt.gasUsed)) : key === candidate.contract.toLowerCase() ? expectedCandidateIn : 0n;
        if (delta !== expected && key !== wallet) {
          const amount = delta > 0n ? delta - expected : -delta;
          if (amount > 0n) {
            unexpectedCalls.push({ to: key as Address, value: amount.toString() });
            externalValueTransfers.push({ asset: "native", amount: amount.toString(), direction: delta > 0n ? "in" : "out" });
          }
        }
      }
      const successful = receipt.status === "0x1" || receipt.status === "0x01";
      return { success: successful, gasEstimate: quantity(receipt.gasUsed), gasPriceWei: gasPrice, stateDiffAvailable: true, assetDiff, approvalDiff, unexpectedCalls, externalValueTransfers, stateDiff, revertReason: successful ? undefined : "transaction reverted", metadata: { simulationMode: "local_snapshot_transaction", transactionHash: hash, watchedAddressCount: this.watchAddresses.length } };
    } catch (error) {
      return { success: false, stateDiffAvailable: true, assetDiff: [], approvalDiff: [], revertReason: error instanceof Error ? error.message : String(error), metadata: { simulationMode: "local_snapshot_transaction", watchedAddressCount: this.watchAddresses.length } };
    } finally {
      await this.rpc("evm_revert", [snapshot]);
    }
  }
}
