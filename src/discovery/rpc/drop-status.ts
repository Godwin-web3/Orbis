import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DropStatusStore } from "../../domain/ports";
import type { DropStatus } from "../../domain/types";

export class JsonlDropStatusStore implements DropStatusStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, DropStatus>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, DropStatus>;
    } catch {
      return {};
    }
  }

  async save(status: DropStatus): Promise<void> {
    const data = await this.read();
    data[status.id] = status;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data));
  }

  async list(): Promise<DropStatus[]> {
    return Object.values(await this.read());
  }
}
