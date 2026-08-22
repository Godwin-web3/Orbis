import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Tracks the last block number scanned per chain, so a discovery pass picks up where the previous one left off instead of only sampling a fixed recent window every run. */
export interface BlockCursorStore {
  get(chainKey: string): Promise<bigint | undefined>;
  set(chainKey: string, block: bigint): Promise<void>;
}

export class JsonlBlockCursorStore implements BlockCursorStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async get(chainKey: string): Promise<bigint | undefined> {
    const data = await this.read();
    return data[chainKey] !== undefined ? BigInt(data[chainKey]) : undefined;
  }

  async set(chainKey: string, block: bigint): Promise<void> {
    const data = await this.read();
    data[chainKey] = block.toString();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data));
  }
}
