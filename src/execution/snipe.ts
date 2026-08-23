import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DropStatusStore } from "../domain/ports";
import type { DropStatus } from "../domain/types";
import type { UserKeyStore } from "../users/keystore";
import type { AutoMintLog } from "./automint";
import { SEADROP_ADDRESS, encodeMintPublic, readPublicDrop, resolveFeeRecipient } from "../discovery/rpc/seadrop-source";
import { blastToAll, prepareBlast, waitForReceipt } from "./rpc-blast";

/** Every "upcoming" drop whose start time falls within the arm window and hasn't already been picked up this pass. Pure and separately tested — the actual timing/network work happens in SnipeScheduler.armAndFire. */
export function selectArmTargets(all: DropStatus[], now: number, armLeadSeconds: number, alreadyArming: Set<string>): DropStatus[] {
  return all.filter((d) => d.status === "upcoming" && d.startTime > now && d.startTime - now <= armLeadSeconds && !alreadyArming.has(d.id));
}

function txKey(chainId: number, to: Address, data: string): string {
  return `${chainId}:${to}:${data}`;
}

function sleepUntil(unixSeconds: number): Promise<void> {
  const delayMs = unixSeconds * 1000 - Date.now();
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

export type SnipeSchedulerConfig = {
  dropStatusStore: DropStatusStore;
  keystore: UserKeyStore;
  guard: { get(): boolean };
  log: AutoMintLog;
  notify: (userId: string, text: string) => Promise<void>;
  rpcUrlsFor: (chainKey: string) => string[];
  chainIdFor: (chainKey: string) => number | undefined;
  /** How long before a drop's known start time to begin preparing (re-verify, sign, hold). Default 15s — long enough to sign every opted-in user's tx before the exact moment, short enough that gas price/nonce are still fresh when fired. */
  armLeadSeconds?: number;
  quantity?: number;
  onError?: (error: unknown, context: string) => void;
};

/**
 * Turns "the bot happens to notice a live drop within the next scan cycle" into "the bot
 * knows a drop is coming and is ready the instant it opens" — see morsyxbt/nft-public-mint
 * for the technique this borrows: sign every opted-in user's transaction *before* the drop
 * opens, then broadcast the already-signed bytes to several RPC endpoints at once the exact
 * moment it does. Only ever acts on SeaDrop's public phase (mintPublic — no signature/
 * allowlist proof involved), same boundary as the rest of this codebase's SeaDrop support;
 * see seadrop-source.ts's doc comment for why allowlist/FCFS phases are out of scope.
 *
 * Targets come from two places, both landing in the same `dropStatusStore` as an
 * `"upcoming"` DropStatus: normal discovery (SeaDropDiscoverySource, automatic), and
 * /snipe (a user manually pointing the bot at one, see bot.ts). This scheduler doesn't
 * care which — it just arms whatever it finds with a close-enough start time.
 */
export class SnipeScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly arming = new Set<string>();

  constructor(private readonly deps: SnipeSchedulerConfig) {}

  async runOnce(): Promise<void> {
    if (!this.deps.guard.get()) return;
    const all = await this.deps.dropStatusStore.list();
    const now = Math.floor(Date.now() / 1000);
    const targets = selectArmTargets(all, now, this.deps.armLeadSeconds ?? 15, this.arming);
    for (const target of targets) {
      this.arming.add(target.id);
      this.armAndFire(target)
        .catch((error) => this.deps.onError?.(error, `snipe ${target.chainKey}:${target.nftContract}`))
        .finally(() => this.arming.delete(target.id));
    }
  }

  private async armAndFire(target: DropStatus): Promise<void> {
    const rpcUrls = this.deps.rpcUrlsFor(target.chainKey);
    const chainId = this.deps.chainIdFor(target.chainKey);
    if (!rpcUrls.length || !chainId) return; // no RPC configured for this chain — nothing we can do

    const client = createPublicClient({ transport: http(rpcUrls[0]) });
    const drop = await readPublicDrop(client, target.nftContract);
    if (!drop || drop.mintPrice !== 0n) return; // no longer a real, free SeaDrop drop — bail quietly, discovery will re-classify it next scan
    const feeRecipient = await resolveFeeRecipient(client, target.nftContract, drop.restrictFeeRecipients);
    if (!feeRecipient) return; // restricted and nothing allowed — can't build a valid call

    const quantity = BigInt(this.deps.quantity ?? 1);
    const data = encodeMintPublic(target.nftContract, feeRecipient, quantity);
    const key = txKey(chainId, SEADROP_ADDRESS, data);

    const users = await this.deps.keystore.listEnabled();
    const signed: { userId: string; rawTx: `0x${string}` }[] = [];
    for (const user of users) {
      if (await this.deps.log.hasAttempt(user.userId, key)) continue;
      const privateKey = await this.deps.keystore.getDecryptedKey(user.userId);
      if (!privateKey) continue;
      try {
        signed.push({ userId: user.userId, rawTx: await this.signFor(client, chainId, privateKey, user.address, data) });
      } catch (error) {
        await this.deps.notify(user.userId, `Snipe prep failed for ${target.name ?? target.nftContract}: ${(error as Error).message}`);
      }
    }
    if (!signed.length) return;

    await sleepUntil(target.startTime);
    await Promise.all(signed.map(({ userId, rawTx }) => this.fireAndRecord(rpcUrls, key, userId, rawTx, target)));
  }

  private async signFor(client: PublicClient, chainId: number, privateKey: `0x${string}`, from: Address, data: `0x${string}`): Promise<`0x${string}`> {
    const account = privateKeyToAccount(privateKey);
    const [nonce, fees, gas] = await Promise.all([
      client.getTransactionCount({ address: from, blockTag: "pending" }),
      client.estimateFeesPerGas(),
      client.estimateGas({ account: from, to: SEADROP_ADDRESS, data, value: 0n }),
    ]);
    return account.signTransaction({
      chainId,
      to: SEADROP_ADDRESS,
      data,
      value: 0n,
      nonce,
      gas: (gas * 12n) / 10n, // 20% headroom — the estimate is against current state, which may shift slightly by fire time
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: "eip1559",
    });
  }

  private async fireAndRecord(rpcUrls: string[], key: string, userId: string, rawTx: `0x${string}`, target: DropStatus): Promise<void> {
    const label = target.name ?? target.nftContract;
    const { txHash, results } = blastToAll(prepareBlast(rawTx), rpcUrls);
    const settled = await results;
    const accepted = settled.some((r) => r.txHash !== null);
    if (!accepted) {
      const reasons = [...new Set(settled.map((r) => r.error).filter(Boolean))];
      await this.deps.log.record({ userId, txKey: key, status: "error", error: reasons.join("; ") || "rejected by every RPC", at: new Date().toISOString() });
      await this.deps.notify(userId, `Snipe FAILED — ${label} — rejected by every RPC: ${reasons.join("; ")}`);
      return;
    }
    const receipt = await waitForReceipt(rpcUrls[0], txHash, 60_000);
    const success = receipt?.status === "success";
    await this.deps.log.record({ userId, txKey: key, status: success ? "success" : "failed", txHash, at: new Date().toISOString() });
    await this.deps.notify(userId, receipt ? `Snipe ${success ? "succeeded" : "FAILED"} — ${label}\nTX: ${txHash}` : `Snipe dispatched but no receipt yet — ${label}\nTX: ${txHash} (check the explorer)`);
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.deps.onError?.(error, "snipe scheduler tick"));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
