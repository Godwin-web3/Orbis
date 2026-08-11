import { exists } from "node:fs/promises";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

export class FileCandidateSource implements DiscoverySource {
  readonly name = "file";
  constructor(private readonly path = process.env.CANDIDATE_FILE ?? "") {}
  async discover(): Promise<MintCandidate[]> {
    if (!this.path || !(await exists(this.path))) return [];
    const lines = await Bun.file(this.path).text();
    return lines.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const raw = JSON.parse(line) as Omit<MintCandidate, "valueWei"> & { valueWei: string };
      return { ...raw, valueWei: BigInt(raw.valueWei) };
    });
  }
}
