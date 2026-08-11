import { zeroAddress, type Address } from "viem";
import { publicClient } from "../../chains/registry";
import { chains } from "../../../config/chains";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

const ERC721 = "0x80ac58cd" as const;
const ERC1155 = "0xd9b67a26" as const;

export class ContractScanSource implements DiscoverySource {
  readonly name = "contract-scan";
  constructor(private readonly chainKey = "base", private readonly addresses: Address[] = []) {}
  async discover(): Promise<MintCandidate[]> {
    const config = chains[this.chainKey];
    const client = config ? publicClient(config) : undefined;
    if (!client) return [];
    const results: MintCandidate[] = [];
    for (const address of this.addresses) {
      let isNft = false;
      for (const interfaceId of [ERC721, ERC1155]) {
        try {
          isNft = Boolean(await client.readContract({ address, abi: [{ type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ name: "interfaceId", type: "bytes4" }], outputs: [{ type: "bool" }] }], functionName: "supportsInterface", args: [interfaceId] }));
          if (isNft) break;
        } catch {}
      }
      if (!isNft) continue;
      results.push({ id: `${this.chainKey}:${address}`, chainKey: this.chainKey, contract: address, source: this.name, discoveredAt: new Date().toISOString(), valueWei: 0n, metadata: { assetType: "nft", addressSource: zeroAddress } });
    }
    return results;
  }
}
