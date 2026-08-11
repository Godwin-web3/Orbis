import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CandidateStore } from "../domain/ports";
import type { MintCandidate } from "../domain/types";

export class JsonlCandidateStore implements CandidateStore {
  constructor(private readonly path: string) {}
  async save(candidate: MintCandidate): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ ...candidate, valueWei: candidate.valueWei.toString() })}\n`);
  }
  async list(): Promise<MintCandidate[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    return (await file.text()).split("\n").filter(Boolean).map((line) => { const raw = JSON.parse(line) as Omit<MintCandidate, "valueWei"> & { valueWei: string }; return { ...raw, valueWei: BigInt(raw.valueWei) }; });
  }
}
