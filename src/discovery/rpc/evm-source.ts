import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { detectMintFunction } from "../contract/detector";

export type RpcDiscoveryConfig = {
  chainKey: string;
  rpcUrls: string[];
  contracts: Address[];
  client?: PublicClient;
};

export class EvmRpcDiscoverySource implements DiscoverySource {
  readonly name = "evm-rpc";
  constructor(private readonly config: RpcDiscoveryConfig) {}

  private get clients(): PublicClient[] {
    if (this.config.client) return [this.config.client];
    return this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) }));
  }

  async discover(): Promise<MintCandidate[]> {
    const candidates: MintCandidate[] = [];
    for (const contract of this.config.contracts) {
      let bytecode: `0x${string}` | undefined;
      for (const client of this.clients) {
        try { bytecode = await client.getBytecode({ address: contract }); break; } catch {}
      }
      if (!bytecode) continue;
      for (const mintFunction of detectMintFunction(bytecode)) {
        candidates.push({ id: `${this.config.chainKey}:${contract}:${mintFunction}`, chainKey: this.config.chainKey, contract, source: this.name, discoveredAt: new Date().toISOString(), mintFunction, valueWei: 0n, metadata: { assetType: "nft", bytecodeDetected: true } });
      }
    }
    return candidates;
  }
}
