import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { PreparedTransactionStore } from "../domain/ports";
import type { MintCandidate, Opportunity, PreparedTransaction, SimulationResult, TransactionRequest } from "../domain/types";

export class RpcTransactionPreparer {
  constructor(private readonly clients: Record<string, PublicClient>, private readonly store: PreparedTransactionStore) {}
  async prepare(candidate: MintCandidate, opportunity: Opportunity, simulation: SimulationResult, decision: { allowed: boolean; reasons: string[] }, request: TransactionRequest): Promise<PreparedTransaction> {
    const client = this.clients[candidate.chainKey];
    if (!client || !simulation.gasEstimate || !simulation.gasPriceWei) throw new Error(`cannot prepare ${candidate.id}: missing RPC or gas result`);
    const chainId = await client.getChainId();
    // request.to is the contract actually called — for a SeaDrop mint that's OpenSea's
    // shared SeaDrop router, not the collection itself, so metadata.nftContract (when
    // present) is what a viewer actually wants to see and click through to.
    const nftContract = typeof candidate.metadata.nftContract === "string" ? candidate.metadata.nftContract as Address : undefined;
    const name = typeof candidate.metadata.name === "string" ? candidate.metadata.name : undefined;
    const num = (key: string): number | undefined => {
      const value = Number(candidate.metadata[key]);
      return Number.isFinite(value) ? value : undefined;
    };
    const prepared: PreparedTransaction = {
      ...request,
      chainId,
      gas: simulation.gasEstimate,
      gasPriceWei: simulation.gasPriceWei,
      simulationMode: String(simulation.metadata?.simulationMode ?? "unknown"),
      policy: decision.allowed ? "PASS" : opportunity.expectedValueNative <= 0 ? "SKIP" : "REJECT",
      reasons: decision.reasons,
      preparedAt: new Date().toISOString(),
      candidateId: candidate.id,
      mintFunction: candidate.mintFunction,
      abi: candidate.abi,
      ...(nftContract ? { nftContract } : {}),
      ...(name ? { name } : {}),
      ...(num("estimatedValueNative") !== undefined ? { estimatedValueNative: num("estimatedValueNative") } : {}),
      ...(num("floorNative") !== undefined ? { floorNative: num("floorNative") } : {}),
      ...(num("recentMints") !== undefined ? { recentMints: num("recentMints") } : {}),
      ...(num("valueScore") !== undefined ? { valueScore: num("valueScore") } : {}),
    };
    await this.store.save(prepared);
    return prepared;
  }
}
export function makeClients(configs: { chainKey: string; rpcUrl: string }[]) { return Object.fromEntries(configs.map(({ chainKey, rpcUrl }) => [chainKey, createPublicClient({ transport: http(rpcUrl) })])); }
