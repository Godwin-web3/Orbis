import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Address } from "../domain/types";

export type RegisteredUser = { userId: string; address: Address; registeredAt: string };

export interface UserRegistry {
  register(userId: string, address: Address): Promise<RegisteredUser>;
  addressFor(userId: string): Promise<Address | undefined>;
  list(): Promise<RegisteredUser[]>;
}

function isValidAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export class JsonlUserRegistry implements UserRegistry {
  constructor(private readonly path: string) {}

  async register(userId: string, address: Address): Promise<RegisteredUser> {
    if (!isValidAddress(address)) throw new Error(`Invalid address: ${address}`);
    const user: RegisteredUser = { userId, address, registeredAt: new Date().toISOString() };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(user)}\n`);
    return user;
  }

  async addressFor(userId: string): Promise<Address | undefined> {
    const users = await this.list();
    for (let i = users.length - 1; i >= 0; i--) {
      if (users[i].userId === userId) return users[i].address;
    }
    return undefined;
  }

  async list(): Promise<RegisteredUser[]> {
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as RegisteredUser);
    } catch {
      return [];
    }
  }
}
