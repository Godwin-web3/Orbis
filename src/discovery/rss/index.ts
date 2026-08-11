import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export class RssSource implements DiscoverySource {
  readonly name = "rss";
  async discover(): Promise<MintCandidate[]> { return []; }
}
