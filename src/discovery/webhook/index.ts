import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export class WebhookSource implements DiscoverySource {
  readonly name = "webhook";
  async discover(): Promise<MintCandidate[]> { return []; }
}
