import { createPublicClient, http, type Abi, type Address, type PublicClient } from "viem";
import type { ContractInspector } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export type AbiResolverConfig = { sourcify?: string; explorer?: string; explorerApiKey?: string; explorerChainParam?: string };

export type AbiResolver = (chainId: number, address: Address) => Promise<Abi | undefined>;

export class CompositeAbiResolver {
  constructor(private readonly config: AbiResolverConfig = {}) {}
  async resolve(chainId: number, address: Address): Promise<Abi | undefined> {
    if (this.config.explorer) {
      const url = new URL(this.config.explorer);
      url.search = new URLSearchParams({ module: "contract", action: "getabi", address, ...(this.config.explorerChainParam ? { chainid: this.config.explorerChainParam } : {}), ...(this.config.explorerApiKey ? { apikey: this.config.explorerApiKey } : {}) }).toString();
      try {
        const body = await (await fetch(url)).json() as { status?: string; result?: string };
        if (body.status === "1" && body.result) return JSON.parse(body.result) as Abi;
      } catch {}
    }
    return new SourcifyAbiResolver(this.config.sourcify).resolve(chainId, address);
  }
}

export class SourcifyAbiResolver {
  constructor(private readonly baseUrl = "https://sourcify.dev/server") {}
  async resolve(chainId: number, address: Address): Promise<Abi | undefined> {
    const response = await fetch(`${this.baseUrl}/v2/contract/${chainId}/${address}?fields=all`);
    if (!response.ok) return undefined;
    const body = await response.json() as { abi?: Abi; metadata?: string; files?: { "metadata.json"?: string } };
    if (body.abi) return body.abi;
    const metadataText = body.metadata ?? body.files?.["metadata.json"];
    if (!metadataText) return undefined;
    try { return (JSON.parse(metadataText) as { output?: { abi?: Abi } }).output?.abi; } catch { return undefined; }
  }
}

export class EvmContractAbiInspector implements ContractInspector {
  constructor(private readonly rpcUrls: string[], private readonly resolver: AbiResolver = new CompositeAbiResolver({ explorer: process.env.EXPLORER_API_URL, explorerApiKey: process.env.EXPLORER_API_KEY }).resolve.bind(new CompositeAbiResolver({ explorer: process.env.EXPLORER_API_URL, explorerApiKey: process.env.EXPLORER_API_KEY })), private readonly client?: PublicClient) {}
  private get clients(): PublicClient[] { return this.client ? [this.client] : this.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }
  async inspect(candidate: MintCandidate): Promise<MintCandidate> {
    for (const client of this.clients) {
      try {
        const chainId = await client.getChainId();
        const abi = await this.resolver(chainId, candidate.contract);
        if (abi) return { ...candidate, metadata: { ...candidate.metadata, abi: abi as unknown as Record<string, unknown>, abiSource: "verified" } };
      } catch {}
    }
    return candidate;
  }
}
