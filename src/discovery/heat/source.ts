import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { detectMintFunction, identifyCandidate } from "../contract/detector";
import { fetchTrendingFreeMints, type TrendingMint } from "./trending";

export type TrendingDiscoveryConfig = { chainKey: string; rpcUrls: string[]; client?: PublicClient; minRecentMints?: number };

/**
 * Surfaces collections with real, live mint velocity right now — not "somebody minted
 * this once," but Reservoir's trending-mints ranking over a short window (10m by
 * default), which is exactly what a person watching mint counts tick up would call a
 * real runner. This used to be wired as a "boost" into SeaDropDiscoverySource's config
 * (see the now-removed `boosts` option there), but that source never actually read it —
 * dead code that enriched nothing. A standalone source is both simpler and strictly more
 * capable: it surfaces a hot collection on its own, whether or not SeaDrop's or the block
 * scanner's own discovery has caught up to it yet.
 *
 * Reservoir only indexes Ethereum and Base (see trending.ts) — this is a no-op elsewhere,
 * including Robinhood Chain.
 */
export class TrendingMintDiscoverySource implements DiscoverySource {
  readonly name = "trending";
  constructor(private readonly config: TrendingDiscoveryConfig) {}

  private get clients(): PublicClient[] { return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }

  async discover(): Promise<MintCandidate[]> {
    const minRecentMints = this.config.minRecentMints ?? Number(process.env.TRENDING_MIN_MINTS ?? "5");
    const rows = await fetchTrendingFreeMints(this.config.chainKey);
    const runners = rows.filter((row) => row.mintCount >= minRecentMints);
    console.log(`[${this.config.chainKey}] trending: ${rows.length} free mint(s) reported, ${runners.length} real runner(s) (>=${minRecentMints} mints in window)`);
    const candidates: MintCandidate[] = [];
    for (const row of runners) candidates.push(...(await this.candidatesFor(row)));
    return candidates;
  }

  private async candidatesFor(row: TrendingMint): Promise<MintCandidate[]> {
    for (const client of this.clients) {
      try {
        const bytecode = await client.getBytecode({ address: row.contract as Address });
        if (!bytecode) continue;
        const mintFunctions = detectMintFunction(bytecode);
        return mintFunctions.map((mintFunction) => {
          const candidate = identifyCandidate(row.contract as Address, this.config.chainKey, this.name, mintFunction);
          return {
            ...candidate,
            metadata: {
              ...candidate.metadata,
              ...(row.name ? { name: row.name } : {}),
              recentMints: row.mintCount,
              ...(row.uniqueMinters !== undefined ? { uniqueMinters: row.uniqueMinters } : {}),
              ...(row.floorNative !== undefined ? { floorNative: row.floorNative } : {}),
            },
          };
        });
      } catch {}
    }
    return [];
  }
}
