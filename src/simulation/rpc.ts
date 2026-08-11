import { createPublicClient, http, type PublicClient } from "viem";
import type { Simulator } from "../domain/ports";
import type { Address, AssetDiff, ExternalCall, MintCandidate, SimulationResult, TransactionRequest } from "../domain/types";
import { buildMintCalldata } from "../discovery/contract/detector";
import { chains } from "../../config/chains";

type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;

type TraceLog = { address?: string; topics?: string[]; data?: string };
type CallTrace = { type?: string; from?: string; to?: string; value?: string; input?: string; output?: string; error?: string; calls?: CallTrace[]; logs?: TraceLog[] };

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function quantity(value: string | undefined): bigint {
  if (!value) return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

function normalizeAddress(value: string | undefined): Address | undefined {
  return value?.toLowerCase() as Address | undefined;
}

function topicAddress(topic: string | undefined): Address | undefined {
  if (!topic || topic.length < 42) return undefined;
  return `0x${topic.slice(-40)}`.toLowerCase() as Address;
}

function parseAmount(data: string | undefined): string | undefined {
  if (!data || data === "0x") return undefined;
  try { return BigInt(data).toString(); } catch { return undefined; }
}

function flattenCalls(root: CallTrace | undefined): CallTrace[] {
  if (!root) return [];
  return [root, ...(root.calls ?? []).flatMap(flattenCalls)];
}

function collectLogs(root: CallTrace | undefined): TraceLog[] {
  return flattenCalls(root).flatMap((call) => call.logs ?? []);
}

function decodeCallAssetDiff(trace: CallTrace | undefined, wallet: Address): AssetDiff[] {
  const diffs: AssetDiff[] = [];
  for (const log of collectLogs(trace)) {
    const topics = log.topics ?? [];
    const topic0 = topics[0]?.toLowerCase();
    if (topic0 !== TRANSFER_TOPIC || !log.address) continue;
    const from = topicAddress(topics[1]);
    const to = topicAddress(topics[2]);
    if (!from || !to) continue;
    const isIncoming = to === wallet;
    const isOutgoing = from === wallet;
    if (!isIncoming && !isOutgoing) continue;
    if (topics.length >= 4) {
      diffs.push({ kind: "nft", direction: isIncoming ? "in" : "out", token: normalizeAddress(log.address), tokenId: quantity(topics[3]).toString() });
    } else {
      diffs.push({ kind: "erc20", direction: isIncoming ? "in" : "out", token: normalizeAddress(log.address), amount: parseAmount(log.data) });
    }
  }
  return diffs;
}

function decodeApprovalDiff(trace: CallTrace | undefined, wallet: Address) {
  const diffs = flattenCalls(trace).flatMap((call) => {
    const input = call.input?.toLowerCase();
    const from = normalizeAddress(call.from);
    const token = normalizeAddress(call.to);
    if (!input || from !== wallet || !token) return [];
    if (input.startsWith("0x095ea7b3") && input.length >= 138) {
      return [{ token, owner: wallet, spender: `0x${input.slice(34, 74)}`.toLowerCase() as Address, amount: quantity(`0x${input.slice(74, 138)}`).toString() }];
    }
    if (input.startsWith("0xa22cb465") && input.length >= 138) {
      return [{ token, owner: wallet, spender: `0x${input.slice(34, 74)}`.toLowerCase() as Address, amount: input.slice(74, 138) === "0".repeat(64) ? "0" : "unlimited" }];
    }
    return [];
  });
  return [...new Map(diffs.map((diff) => [`${diff.token}:${diff.spender}:${diff.amount}`, diff])).values()];
}

function decodeUnexpectedCalls(trace: CallTrace | undefined, wallet: Address): ExternalCall[] {
  return flattenCalls(trace).flatMap((call, index) => {
    if (index === 0) return [];
    const value = quantity(call.value);
    const from = normalizeAddress(call.from);
    if (value === 0n || from === wallet) return [];
    return [{ to: normalizeAddress(call.to), value: value.toString(), input: call.input }];
  });
}

function parseTraceRevert(trace: CallTrace | undefined): string | undefined {
  if (!trace) return undefined;
  if (trace.error) return trace.error;
  for (const child of trace.calls ?? []) {
    const reason = parseTraceRevert(child);
    if (reason) return reason;
  }
  return undefined;
}

function collectTraceState(trace: CallTrace | undefined, wallet: Address): { assetDiff: AssetDiff[]; approvalDiff: ReturnType<typeof decodeApprovalDiff>; unexpectedCalls: ExternalCall[] } {
  return {
    assetDiff: decodeCallAssetDiff(trace, wallet),
    approvalDiff: decodeApprovalDiff(trace, wallet),
    unexpectedCalls: decodeUnexpectedCalls(trace, wallet),
  };
}

export class JsonRpcTransport {
  private nextId = 1;
  constructor(private readonly url: string, private readonly timeoutMs = 8000) {}
  async request(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
      if (body.error) throw new Error(`RPC ${body.error.code ?? "error"}: ${body.error.message ?? "request failed"}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class RpcTransportPool {
  private cursor = 0;
  constructor(private readonly transports: RpcRequest[]) {}
  async request(method: string, params: unknown[]): Promise<unknown> {
    if (!this.transports.length) throw new Error("no RPC providers configured");
    let lastError: unknown;
    for (let offset = 0; offset < this.transports.length; offset++) {
      const index = (this.cursor + offset) % this.transports.length;
      try {
        const result = await this.transports[index](method, params);
        this.cursor = index;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all RPC providers failed");
  }
}

export class RpcSimulator implements Simulator {
  private readonly clients: Record<string, PublicClient>;
  private readonly transports: Record<string, RpcRequest>;
  constructor(clients: Record<string, PublicClient> = {}, transports: Record<string, RpcRequest> = {}) {
    this.clients = clients;
    this.transports = transports;
  }

  private getTransport(chainKey: string): RpcRequest | undefined {
    if (this.transports[chainKey]) return this.transports[chainKey];
    if (this.clients[chainKey]) {
      const client = this.clients[chainKey];
      const request = (method: string, params: unknown[] = []) => client.request({ method, params } as any);
      this.transports[chainKey] = request as RpcRequest;
      return this.transports[chainKey];
    }
    const config = chains[chainKey];
    const urls = config ? (process.env[config.rpcEnv] ?? "").split(",").map((url) => url.trim()).filter(Boolean) : [];
    if (!urls.length) return undefined;
    const pool = new RpcTransportPool(urls.map((url) => { const transport = new JsonRpcTransport(url); return transport.request.bind(transport); }));
    this.transports[chainKey] = pool.request.bind(pool);
    return this.transports[chainKey];
  }

  async simulate(candidate: MintCandidate, request?: TransactionRequest): Promise<SimulationResult> {
    const rpc = this.getTransport(candidate.chainKey);
    const data = request?.data ?? candidate.calldata ?? buildMintCalldata(candidate);
    const wallet = normalizeAddress(request?.from ?? candidate.from ?? process.env.SIMULATION_FROM);
    if (!rpc) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "RPC provider is not configured" };
    if (!data) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "unable to construct mint calldata" };
    if (!wallet) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "SIMULATION_FROM is required for state-diff verification" };
    const tx = { from: wallet, to: candidate.contract, data, value: hex(request?.value ?? candidate.valueWei) };
    try {
      const [gasHex, gasPriceHex] = await Promise.all([rpc("eth_estimateGas", [tx]) as Promise<string>, rpc("eth_gasPrice", []) as Promise<string>]);
      await rpc("eth_call", [tx, "latest"]);
      let trace: CallTrace | undefined;
      try {
        trace = await rpc("debug_traceCall", [tx, "latest", { tracer: "callTracer", tracerConfig: { withLog: true } }]) as CallTrace;
      } catch {}
      const traceState = collectTraceState(trace, wallet);
      const assetDiff = traceState.assetDiff;
      const approvalDiff = traceState.approvalDiff;
      const unexpectedCalls = traceState.unexpectedCalls;
      const traceRevert = parseTraceRevert(trace);
      if (traceRevert) return { success: false, gasEstimate: BigInt(gasHex), gasPriceWei: BigInt(gasPriceHex), stateDiffAvailable: Boolean(trace), assetDiff, approvalDiff, unexpectedCalls, revertReason: traceRevert, metadata: { simulationMode: "debug_traceCall" } };
      return { success: true, gasEstimate: BigInt(gasHex), gasPriceWei: BigInt(gasPriceHex), stateDiffAvailable: Boolean(trace), assetDiff, approvalDiff, unexpectedCalls, metadata: { simulationMode: trace ? "eth_call_debug_traceCall" : "eth_call_only" } };
    } catch (error) {
      return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: error instanceof Error ? error.message : String(error) };
    }
  }
}

