import { encodeFunctionData, type Address } from "viem";
import type { DiscoverySource, DropStatusStore } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { fetchHoodMintDrops, type HoodMintDrop } from "./hoodmint";
import { HoodseaDiscoverySource } from "./hoodsea";
import { isAffordableMint, parsePriceToWei } from "./price";

const GENERIC_MINT_ABI = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
] as const;

function hoodmintCandidate(chainKey: string, drop: HoodMintDrop): MintCandidate | undefined {
  if (!drop.contract) return undefined;
  if (drop.status === "sold_out" || drop.status === "soldout") return undefined;
  if (drop.supply !== undefined && drop.minted !== undefined && drop.minted >= drop.supply) return undefined;
  const priceWei = drop.priceWei ?? (drop.free ? 0n : undefined);
  if (priceWei === undefined || !isAffordableMint(priceWei)) return undefined;
  const minted = drop.minted ?? 0;
  return {
    id: `${chainKey}:hoodmint:${drop.contract}`,
    chainKey,
    contract: drop.contract,
    source: "hoodmint",
    discoveredAt: new Date().toISOString(),
    mintFunction: "mint",
    calldata: encodeFunctionData({ abi: GENERIC_MINT_ABI, functionName: "mint", args: [1n] }),
    valueWei: priceWei,
    active: true,
    eligible: true,
    metadata: {
      assetType: "nft",
      launchpad: "hoodmint",
      nftContract: drop.contract,
      name: drop.name,
      recentMints: minted,
      valueSignal: minted >= 1,
      mintPrice: priceWei.toString(),
      ...(drop.ticker ? { ticker: drop.ticker } : {}),
      ...(drop.url ? { mintUrl: drop.url } : { mintUrl: "https://hoodmint.online/drops/open" }),
    },
  };
}

export class HoodMintDiscoverySource implements DiscoverySource {
  readonly name = "hoodmint";
  constructor(private readonly chainKey: string, private readonly fetchImpl?: typeof fetch) {}
  async discover(): Promise<MintCandidate[]> {
    if (this.chainKey !== "robinhood") return [];
    const drops = await fetchHoodMintDrops({ fetchImpl: this.fetchImpl });
    const candidates = drops.map((drop) => hoodmintCandidate(this.chainKey, drop)).filter((row): row is MintCandidate => Boolean(row));
    console.log(`[${this.chainKey}] hoodmint: ${drops.length} drop(s) listed, ${candidates.length} cheap with a contract`);
    return candidates;
  }
}

export class RobinhoodLaunchpadSource implements DiscoverySource {
  readonly name = "rh-launchpads";
  constructor(
    private readonly config: {
      chainKey: string;
      rpcUrls: string[];
      dropStatusStore?: DropStatusStore;
    },
  ) {}

  async discover(): Promise<MintCandidate[]> {
    if (this.config.chainKey !== "robinhood") return [];
    const hoodmint = new HoodMintDiscoverySource(this.config.chainKey);
    const hoodsea = new HoodseaDiscoverySource({
      chainKey: this.config.chainKey,
      rpcUrls: this.config.rpcUrls,
      dropStatusStore: this.config.dropStatusStore,
    });
    const [a, b] = await Promise.all([hoodmint.discover(), hoodsea.discover()]);
    const seen = new Set<Address>();
    const out: MintCandidate[] = [];
    for (const candidate of [...b, ...a]) {
      const key = (candidate.metadata.nftContract as Address | undefined) ?? candidate.contract;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  }
}

void parsePriceToWei;
