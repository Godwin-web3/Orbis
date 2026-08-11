import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { detectMintFunction } from "../contract/detector";

export type BlockDiscoveryConfig = { chainKey: string; rpcUrls: string[]; startBlock?: bigint; confirmations?: bigint; client?: PublicClient };

export class BlockContractDiscoverySource implements DiscoverySource {
  readonly name = "block-contracts";
  constructor(private readonly config: BlockDiscoveryConfig) {}

  private get clients(): PublicClient[] { return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }

  async discover(): Promise<MintCandidate[]> {
    const candidates: MintCandidate[] = [];
    for (const client of this.clients) {
      try {
        const latest = await client.getBlockNumber();
        const safeLatest = latest - (this.config.confirmations ?? 2n);
        const fromBlock = this.config.startBlock ?? (safeLatest > 20n ? safeLatest - 20n : 0n);
        if (safeLatest < fromBlock) continue;
        const block = await client.getBlock({ blockNumber: safeLatest, includeTransactions: true });
        for (const transaction of block.transactions) {
          if (typeof transaction === "string" || !transaction.to) continue;
          const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
          if (receipt.contractAddress) await this.addCandidate(client, receipt.contractAddress, candidates);
        }
        break;
      } catch {}
    }
    return candidates;
  }

  private async addCandidate(client: PublicClient, contract: Address, candidates: MintCandidate[]) {
    const bytecode = await client.getBytecode({ address: contract });
    if (!bytecode) return;
    for (const mintFunction of detectMintFunction(bytecode)) candidates.push({ id: `${this.config.chainKey}:${contract}:${mintFunction}`, chainKey: this.config.chainKey, contract, source: this.name, discoveredAt: new Date().toISOString(), mintFunction, valueWei: 0n, metadata: { assetType: "nft", bytecodeDetected: true, discoveredFromRecentDeployment: true } });
  }
}
