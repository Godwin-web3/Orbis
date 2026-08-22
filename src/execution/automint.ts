import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PreparedTransactionStore } from "../domain/ports";
import type { PreparedTransaction } from "../domain/types";
import type { UserKeyStore } from "../users/keystore";
import { RpcExecutor } from "./executor";

function txKey(tx: PreparedTransaction): string {
  return `${tx.chainId}:${tx.to}:${tx.data}`;
}

export type AutoMintAttempt = { userId: string; txKey: string; status: "success" | "failed" | "error"; txHash?: string; error?: string; at: string };

export interface AutoMintLog {
  hasAttempt(userId: string, key: string): Promise<boolean>;
  record(attempt: AutoMintAttempt): Promise<void>;
}

/**
 * Every (user, opportunity) pair is attempted at most once: on success, failure, or
 * error, it's recorded and skipped on future scans. This bounds gas spend on a
 * persistently-failing mint to one attempt rather than retrying every interval.
 */
export class JsonlAutoMintLog implements AutoMintLog {
  constructor(private readonly path: string) {}

  private async all(): Promise<AutoMintAttempt[]> {
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as AutoMintAttempt);
    } catch {
      return [];
    }
  }

  async hasAttempt(userId: string, key: string): Promise<boolean> {
    return (await this.all()).some((attempt) => attempt.userId === userId && attempt.txKey === key);
  }

  async record(attempt: AutoMintAttempt): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(attempt)}\n`);
  }
}

export type AutoMintCaps = { maxPerUserPerScan: number; maxTotalPerScan: number };

/**
 * Background loop: on each tick, for every user who has opted into auto-mint
 * (supplied their own burner-wallet key via /autokey and run /auto on), attempts
 * every un-attempted policy-approved opportunity using THEIR key, bounded by
 * per-user and total-per-scan caps. Requires the operator's live-execution guard
 * to be ON as a master switch, independent of any individual user's opt-in.
 */
export class AutoMintLoop {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      prepared: PreparedTransactionStore;
      keystore: UserKeyStore;
      guard: { get(): boolean };
      log: AutoMintLog;
      caps: AutoMintCaps;
      notify: (userId: string, text: string) => Promise<void>;
      onError?: (error: unknown) => void;
    },
  ) {}

  async runOnce(): Promise<void> {
    if (!this.deps.guard.get()) return;
    const users = await this.deps.keystore.listEnabled();
    if (!users.length) return;
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (!pass.length) return;

    let total = 0;
    for (const user of users) {
      if (total >= this.deps.caps.maxTotalPerScan) break;
      const key = await this.deps.keystore.getDecryptedKey(user.userId);
      if (!key) continue;

      let perUser = 0;
      const executor = new RpcExecutor(key);
      for (const tx of pass) {
        if (perUser >= this.deps.caps.maxPerUserPerScan || total >= this.deps.caps.maxTotalPerScan) break;
        const key2 = txKey(tx);
        if (await this.deps.log.hasAttempt(user.userId, key2)) continue;

        perUser++;
        total++;
        try {
          const { txHash } = await executor.execute(tx);
          const receipt = await executor.verify(txHash, tx);
          await this.deps.log.record({ userId: user.userId, txKey: key2, status: receipt.success ? "success" : "failed", txHash, at: new Date().toISOString() });
          await this.deps.notify(
            user.userId,
            `Auto-mint ${receipt.success ? "succeeded" : "FAILED"} — ${tx.to}\nTX: ${txHash}${receipt.success ? `\nowner confirmed: ${receipt.ownerConfirmed}` : ""}`,
          );
        } catch (error) {
          await this.deps.log.record({ userId: user.userId, txKey: key2, status: "error", error: (error as Error).message, at: new Date().toISOString() });
          await this.deps.notify(user.userId, `Auto-mint aborted — ${tx.to}: ${(error as Error).message}`);
        }
      }
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.deps.onError?.(error));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
