import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { ContractInspector } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

const supportsInterfaceAbi = [{ type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ name: "interfaceId", type: "bytes4" }], outputs: [{ type: "bool" }] }] as const;

export class EvmContractInspector implements ContractInspector {
  constructor(private readonly rpcUrls: string[], private readonly client?: PublicClient) {}
  private get clients(): PublicClient[] { return this.client ? [this.client] : this.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }
  async inspect(candidate: MintCandidate): Promise<MintCandidate> {
    let isNft = false;
    for (const client of this.clients) for (const interfaceId of ["0x80ac58cd", "0xd9b67a26"] as const) {
      try { if (await client.readContract({ address: candidate.contract, abi: supportsInterfaceAbi, functionName: "supportsInterface", args: [interfaceId] })) isNft = true; } catch {}
    }
    return { ...candidate, metadata: { ...candidate.metadata, assetType: isNft ? "nft" : candidate.metadata.assetType, supportsStandardNft: isNft } };
  }
}
