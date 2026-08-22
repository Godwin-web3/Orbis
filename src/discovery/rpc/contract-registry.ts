import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address } from "viem";

export const CONTRACT_REGISTRY_CAP = 200;

/**
 * Remembers every contract a discovery source has ever seen live activity for, per chain,
 * so a source that only reacts to fresh on-chain events (like SeaDropDiscoverySource) can
 * also re-check contracts it already knows about on every pass — not just the ones with a
 * brand-new event inside this particular scan window. A drop that's genuinely free and open
 * but simply hasn't had a mint in the last few minutes would otherwise never resurface.
 * Bounded to CONTRACT_REGISTRY_CAP per key (oldest evicted first) so re-checking known
 * contracts stays cheap indefinitely.
 */
export interface ContractRegistry {
  list(key: string): Promise<Address[]>;
  add(key: string, contract: Address): Promise<void>;
}

export class JsonlContractRegistry implements ContractRegistry {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, Address[]>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, Address[]>;
    } catch {
      return {};
    }
  }

  async list(key: string): Promise<Address[]> {
    const data = await this.read();
    return data[key] ?? [];
  }

  async add(key: string, contract: Address): Promise<void> {
    const data = await this.read();
    const existing = data[key] ?? [];
    if (existing.includes(contract)) return;
    data[key] = [...existing, contract].slice(-CONTRACT_REGISTRY_CAP);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data));
  }
}
