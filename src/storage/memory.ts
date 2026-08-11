import type { CandidateStore } from "../domain/ports";
import type { MintCandidate } from "../domain/types";

export class MemoryCandidateStore implements CandidateStore {
  private readonly items = new Map<string, MintCandidate>();
  async save(candidate: MintCandidate) { this.items.set(candidate.id, candidate); }
  async list() { return [...this.items.values()]; }
}
