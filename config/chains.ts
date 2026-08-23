export type ChainConfig = {
  key: string;
  chainId: number;
  nativeSymbol: string;
  rpcEnv: string;
  explorer?: string;
  /** OpenSea's URL chain segment (opensea.io/assets/<slug>/<contract>), where OpenSea covers this chain. */
  openseaSlug?: string;
  enabled: boolean;
};

export const chains: Record<string, ChainConfig> = {
  ethereum: { key: "ethereum", chainId: 1, nativeSymbol: "ETH", rpcEnv: "ETHEREUM_RPC_URL", explorer: "https://etherscan.io", openseaSlug: "ethereum", enabled: false },
  sepolia: { key: "sepolia", chainId: 11155111, nativeSymbol: "ETH", rpcEnv: "SEPOLIA_RPC_URL", explorer: "https://sepolia.etherscan.io", enabled: false },
  base: { key: "base", chainId: 8453, nativeSymbol: "ETH", rpcEnv: "BASE_RPC_URL", explorer: "https://basescan.org", openseaSlug: "base", enabled: true },
  arbitrum: { key: "arbitrum", chainId: 42161, nativeSymbol: "ETH", rpcEnv: "ARBITRUM_RPC_URL", explorer: "https://arbiscan.io", openseaSlug: "arbitrum", enabled: false },
  optimism: { key: "optimism", chainId: 10, nativeSymbol: "ETH", rpcEnv: "OPTIMISM_RPC_URL", explorer: "https://optimistic.etherscan.io", openseaSlug: "optimism", enabled: false },
  polygon: { key: "polygon", chainId: 137, nativeSymbol: "POL", rpcEnv: "POLYGON_RPC_URL", explorer: "https://polygonscan.com", openseaSlug: "matic", enabled: false },
  robinhood: { key: "robinhood", chainId: 4663, nativeSymbol: "ETH", rpcEnv: "ROBINHOOD_RPC_URL", explorer: "https://robinhoodchain.blockscout.com", openseaSlug: "robinhood", enabled: false },
};

export function enabledChains(): ChainConfig[] {
  const requested = (process.env.ENABLED_CHAINS ?? "base").split(",").map((value) => value.trim()).filter(Boolean);
  return requested.map((key) => chains[key]).filter((chain): chain is ChainConfig => Boolean(chain));
}
