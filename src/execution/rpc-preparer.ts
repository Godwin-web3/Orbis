import { createPublicClient, http, type PublicClient } from "viem";
import type { PreparedTransactionStore } from "../domain/ports";
import type { MintCandidate, Opportunity, PreparedTransaction, SimulationResult, TransactionRequest } from "../domain/types";

export class RpcTransactionPreparer {
  constructor(private readonly clients: Record<string, PublicClient>, private readonly store: PreparedTransactionStore) {}
  async prepare(candidate: MintCandidate, opportunity: Opportunity, simulation: SimulationResult, decision: { allowed: boolean; reasons: string[] }, request: TransactionRequest): Promise<PreparedTransaction> {
    const client = this.clients[candidate.chainKey];
    if (!client || !simulation.gasEstimate || !simulation.gasPriceWei) throw new Error(`cannot prepare ${candidate.id}: missing RPC or gas result`);
    const chainId = await client.getChainId();
    const prepared: PreparedTransaction = { ...request, chainId, gas: simulation.gasEstimate, gasPriceWei: simulation.gasPriceWei, simulationMode: String(simulation.metadata?.simulationMode ?? "unknown"), policy: decision.allowed ? "PASS" : opportunity.expectedValueNative <= 0 ? "SKIP" : "REJECT", reasons: decision.reasons, preparedAt: new Date().toISOString(), candidateId: candidate.id, mintFunction: candidate.mintFunction, abi: candidate.abi }; 
    await this.store.save(prepared);
    return prepared;
  }
}
export function makeClients(configs: { chainKey: string; rpcUrl: string }[]) { return Object.fromEntries(configs.map(({ chainKey, rpcUrl }) => [chainKey, createPublicClient({ transport: http(rpcUrl) })])); }
