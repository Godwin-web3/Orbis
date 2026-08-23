import { createPublicClient, http } from "viem";
import { arbitrum, base, mainnet, optimism, polygon, sepolia } from "viem/chains";
import { chains, type ChainConfig } from "../../config/chains";

const viemChains = { ethereum: mainnet, sepolia, base, arbitrum, optimism, polygon } as const;

export function publicClient(config: ChainConfig) {
  const rpc = process.env[config.rpcEnv];
  if (!rpc) return undefined;
  const chain = viemChains[config.key as keyof typeof viemChains];
  if (!chain) return undefined;
  return createPublicClient({ chain: chain as any, transport: http(rpc) });
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A link a chat viewer can actually look at — OpenSea's collection page where OpenSea covers the chain (its rich preview image is why some bot replies turn on link previews), the block explorer otherwise. */
export function dropLink(chainKey: string, nftContract: string): string | undefined {
  const chain = chains[chainKey];
  if (chain?.openseaSlug) return `https://opensea.io/assets/${chain.openseaSlug}/${nftContract}`;
  return chain?.explorer ? `${chain.explorer}/address/${nftContract}` : undefined;
}

/** Human-readable chain name for a numeric chainId (e.g. from a PreparedTransaction or eth_chainId) — falls back to the raw id for a chain we don't have configured. */
export function chainNameFor(chainId: number): string {
  const entry = Object.values(chains).find((chain) => chain.chainId === chainId);
  return entry ? capitalize(entry.key) : `chain ${chainId}`;
}
