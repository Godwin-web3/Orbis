import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "../domain/types";
import { decryptSecret, encryptSecret, parseEncryptionKey, type EncryptedSecret } from "./crypto";

export { parseEncryptionKey };

type KeyRecord = { userId: string; address: Address; enc?: EncryptedSecret; autoMintEnabled: boolean; removed?: boolean; updatedAt: string };

export interface UserKeyStore {
  /** Encrypts and persists a user-supplied private key (a burner wallet). Disables auto-mint until explicitly re-enabled. */
  setKey(userId: string, privateKey: `0x${string}`): Promise<Address>;
  hasKey(userId: string): Promise<boolean>;
  addressFor(userId: string): Promise<Address | undefined>;
  getDecryptedKey(userId: string): Promise<`0x${string}` | undefined>;
  setAutoMint(userId: string, enabled: boolean): Promise<void>;
  isAutoMintEnabled(userId: string): Promise<boolean>;
  removeKey(userId: string): Promise<void>;
  /** Users who currently have a key on file and have opted into autonomous minting. */
  listEnabled(): Promise<{ userId: string; address: Address }[]>;
}

export class JsonlUserKeyStore implements UserKeyStore {
  constructor(
    private readonly path: string,
    private readonly encryptionKey: Uint8Array,
  ) {}

  private async fold(): Promise<Map<string, KeyRecord>> {
    let lines: string[];
    try {
      lines = (await readFile(this.path, "utf8")).split("\n").filter(Boolean);
    } catch {
      lines = [];
    }
    const byUser = new Map<string, KeyRecord>();
    for (const line of lines) {
      const record = JSON.parse(line) as KeyRecord;
      byUser.set(record.userId, record);
    }
    return byUser;
  }

  private async append(record: KeyRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`);
  }

  async setKey(userId: string, privateKey: `0x${string}`): Promise<Address> {
    const address = privateKeyToAccount(privateKey).address;
    const enc = await encryptSecret(privateKey, this.encryptionKey);
    await this.append({ userId, address, enc, autoMintEnabled: false, updatedAt: new Date().toISOString() });
    return address;
  }

  private async active(userId: string): Promise<KeyRecord | undefined> {
    const record = (await this.fold()).get(userId);
    return record && !record.removed && record.enc ? record : undefined;
  }

  async hasKey(userId: string): Promise<boolean> {
    return (await this.active(userId)) !== undefined;
  }

  async addressFor(userId: string): Promise<Address | undefined> {
    return (await this.active(userId))?.address;
  }

  async getDecryptedKey(userId: string): Promise<`0x${string}` | undefined> {
    const record = await this.active(userId);
    if (!record?.enc) return undefined;
    return (await decryptSecret(record.enc, this.encryptionKey)) as `0x${string}`;
  }

  async setAutoMint(userId: string, enabled: boolean): Promise<void> {
    const record = await this.active(userId);
    if (!record) throw new Error("No burner wallet registered. Use /autokey <privatekey> first.");
    await this.append({ ...record, autoMintEnabled: enabled, updatedAt: new Date().toISOString() });
  }

  async isAutoMintEnabled(userId: string): Promise<boolean> {
    return (await this.active(userId))?.autoMintEnabled === true;
  }

  async removeKey(userId: string): Promise<void> {
    const record = (await this.fold()).get(userId);
    if (!record) return;
    await this.append({ ...record, removed: true, autoMintEnabled: false, updatedAt: new Date().toISOString() });
  }

  async listEnabled(): Promise<{ userId: string; address: Address }[]> {
    const users: { userId: string; address: Address }[] = [];
    for (const record of (await this.fold()).values()) {
      if (!record.removed && record.enc && record.autoMintEnabled) users.push({ userId: record.userId, address: record.address });
    }
    return users;
  }
}
