import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export class MarketplaceSource implements DiscoverySource {
  readonly name = "marketplace";
  async discover(): Promise<MintCandidate[]> { return []; }
}
