import { createPublicClient, http } from "viem";
import { arbitrum, base, mainnet, optimism, polygon, sepolia } from "viem/chains";
import type { ChainConfig } from "../../config/chains";

const viemChains = { ethereum: mainnet, sepolia, base, arbitrum, optimism, polygon } as const;

export function publicClient(config: ChainConfig) {
  const rpc = process.env[config.rpcEnv];
  if (!rpc) return undefined;
  const chain = viemChains[config.key as keyof typeof viemChains];
  if (!chain) return undefined;
  return createPublicClient({ chain: chain as any, transport: http(rpc) });
}
