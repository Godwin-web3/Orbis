import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export class ApiSource implements DiscoverySource {
  readonly name = "api";
  async discover(): Promise<MintCandidate[]> { return []; }
}
