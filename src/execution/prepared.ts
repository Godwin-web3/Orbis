import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PreparedTransactionStore } from "../domain/ports";
import type { PreparedTransaction } from "../domain/types";

function encode(transaction: PreparedTransaction): string { return JSON.stringify({ ...transaction, value: transaction.value.toString(), gas: transaction.gas.toString(), gasPriceWei: transaction.gasPriceWei.toString() }); }
function decode(line: string): PreparedTransaction { const raw = JSON.parse(line) as Omit<PreparedTransaction, "value" | "gas" | "gasPriceWei"> & { value: string; gas: string; gasPriceWei: string }; return { ...raw, value: BigInt(raw.value), gas: BigInt(raw.gas), gasPriceWei: BigInt(raw.gasPriceWei) }; }

export class MemoryPreparedTransactionStore implements PreparedTransactionStore {
  private readonly items = new Map<string, PreparedTransaction>();
  async save(transaction: PreparedTransaction) { this.items.set(`${transaction.chainId}:${transaction.to}:${transaction.data}`, transaction); }
  async list() { return [...this.items.values()]; }
}

export class JsonlPreparedTransactionStore implements PreparedTransactionStore {
  constructor(private readonly path: string) {}
  async save(transaction: PreparedTransaction) { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, `${encode(transaction)}\n`); }
  async list() { try { return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).map(decode); } catch { return []; } }
}
