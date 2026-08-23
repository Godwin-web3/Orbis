import { formatEther } from "viem";
import type { DropStatusStore, PreparedTransactionStore } from "../domain/ports";
import type { DropStatus, PreparedTransaction } from "../domain/types";
import type { RpcExecutor } from "../execution/executor";
import type { UserRegistry } from "../users/registry";
import type { UserKeyStore } from "../users/keystore";
import type { MintRelay } from "../execution/relay";
import type { NonCustodialRelay } from "../execution/noncustodial";
import { chains } from "../../config/chains";

/** Commands that broadcast fleet-wide, spend the operator's own key, or cost RPC/gas on every user's behalf — restricted to TELEGRAM_ADMIN_IDS. Everything else is open to any chat. */
export const ADMIN_ONLY_COMMANDS = new Set(["scan", "ack", "mint-all", "mintall"]);

export type ParsedCommand = { command: string; args: string[] };
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;
  return { command: head.split("@")[0].toLowerCase(), args: rest };
}

/** "3d 4h", "2h 15m", "45m", "just now" — always the two most significant units, never negative (callers pass max(0, ...) or filter to future timestamps). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return "under a minute";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A link a Telegram viewer can actually look at — OpenSea's collection page where OpenSea covers the chain (its rich preview image is why /upcoming turns on link previews), the block explorer otherwise. */
export function dropLink(chainKey: string, nftContract: string): string | undefined {
  const chain = chains[chainKey];
  if (chain?.openseaSlug) return `https://opensea.io/assets/${chain.openseaSlug}/${nftContract}`;
  return chain?.explorer ? `${chain.explorer}/address/${nftContract}` : undefined;
}

export function formatDropStatus(status: DropStatus, now: number): string {
  const title = status.name ? `${status.name} (${status.nftContract})` : status.nftContract;
  const base = `  ${title} · ${status.chainKey}`;
  const link = dropLink(status.chainKey, status.nftContract);
  const suffix = link ? `\n    ${link}` : "";
  if (status.status === "upcoming") return `${base} · opens in ${formatCountdown(status.startTime - now)}${suffix}`;
  if (status.status === "live_free") return `${base} · max ${status.maxTotalMintableByWallet}/wallet${status.endTime ? ` · closes in ${formatCountdown(status.endTime - now)}` : ""}${suffix}`;
  if (status.status === "live_paid") return `${base} · ${formatEther(BigInt(status.mintPriceWei))} ETH${suffix}`;
  return `${base}${suffix}`;
}

export function formatPrepared(tx: PreparedTransaction, index: number): string {
  return [
    `[${index}] ${tx.policy} · ${tx.chainId === 1 ? "Ethereum" : "chain " + tx.chainId}`,
    `  contract: ${tx.to}`,
    `  fn: ${tx.mintFunction ?? "unknown"} · gas: ${tx.gas.toString()} · price: ${tx.gasPriceWei} wei`,
    `  sim: ${tx.simulationMode} · reasons: ${tx.reasons.length ? tx.reasons.join("; ") : "none"}`,
    `  prepared: ${tx.preparedAt}`,
  ].join("\n");
}

export class TelegramCommandBot {
  private offset = 0;
  private stop = false;
  constructor(
    private readonly token: string,
    private readonly allowedChatIds: string[],
    private readonly deps: {
      prepared: PreparedTransactionStore;
      executor?: RpcExecutor;
      relay?: MintRelay;
      nonCustodial?: NonCustodialRelay;
      users: UserRegistry;
      keystore?: UserKeyStore;
      guard: { get(): boolean; set(value: boolean): Promise<void> };
      scan: () => Promise<number>;
      /** Resolves a pasted contract address or URL and runs it through the same classify/simulate/policy pipeline as auto-discovery. */
      target?: (input: string) => Promise<string>;
      /** Every drop a discovery source has ever checked — live free, live paid, upcoming, ended — not just the ones that became a ready-to-mint candidate. Powers /upcoming. */
      dropStatus?: DropStatusStore;
      chainsEnabled: string[];
    },
  ) {}

  private async api(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
    return response.json();
  }

  private async send(chatId: string, text: string, showLinkPreview = false): Promise<void> {
    const chunks = text.match(/.{1,4000}(?:\s|$)/g) ?? [text];
    for (const chunk of chunks) await this.api("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: !showLinkPreview });
  }

  private authorized(chatId: string): boolean { return this.allowedChatIds.includes(chatId); }

  /** Public wrapper so background loops (e.g. AutoMintLoop) can message a user's chat. */
  async sendTo(chatId: string, text: string): Promise<void> { return this.send(chatId, text); }

  /** Link previews only matter for the handful of commands whose output includes an OpenSea/explorer link — enabling it elsewhere would just render an unrelated preview for the operator's own bot-token-looking text or similar noise. */
  private static readonly COMMANDS_WITH_LINK_PREVIEW = new Set(["upcoming", "target"]);

  async handleCommand(chatId: string, parsed: ParsedCommand, meta: { messageId?: number; chatType?: string } = {}): Promise<string> {
    switch (parsed.command) {
      case "help": return this.help();
      case "status": return this.status();
      case "register": return this.register(chatId, parsed.args);
      case "scan": return this.scan();
      case "target": return this.target(parsed.args);
      case "upcoming": return this.upcoming();
      case "prepared": return this.prepared();
      case "mint": return this.mint(chatId, parsed.args);
      case "sign": return this.sign(chatId, parsed.args);
      case "submit": return this.submit(chatId, parsed.args);
      case "mint-all": case "mintall": return this.mintAll();
      case "ack": return this.ack(parsed.args);
      case "autokey": return this.autokey(chatId, parsed.args, meta);
      case "auto": return this.auto(chatId, parsed.args);
      case "autostatus": return this.autostatus(chatId);
      case "forgetkey": return this.forgetkey(chatId);
      default: return `Unknown command /${parsed.command}. Send /help.`;
    }
  }

  private help(): string {
    return [
      "Free Mint Engine — Telegram controls",
      "/register <address> — set the wallet this chat receives NFTs in (no private key needed)",
      "/status — wallet, chains, guard, registered users, prepared count",
      "/scan — run a discovery+simulation+prepare pass",
      "/target <address-or-url> — check one specific contract (raw 0x address, OpenSea/Zora/explorer URL) and run it through the same safety pipeline as auto-discovery",
      "/upcoming — every known drop's status: live & free, live but paid, upcoming (with countdown), not just ready-to-mint ones",
      "/prepared — list mints ready to broadcast",
      "/mint <index> — mint to YOUR registered address (re-verifies free/open/limit)",
      "/sign <index> — build the EXACT transaction for your wallet to sign (non-custodial; you keep your key)",
      "/submit <signed-raw-tx> — relay a tx you signed in your own wallet; the NFT lands in your wallet",
      "/mint-all — batch-broadcast ALL prepared mints in one EIP-7702 tx per chain [admin]",
      "/ack <on|off> — enable/disable live execution guard [admin]",
      "/autokey <privatekey> — register YOUR OWN burner wallet so the bot can auto-mint for you unattended (DM only; use a burner, never your main wallet)",
      "/auto <on|off> — turn your personal auto-mint on/off (off by default, requires /autokey first)",
      "/autostatus — your burner wallet address and auto-mint state",
      "/forgetkey — delete your stored burner wallet key and disable auto-mint",
      "/help — this message",
      "",
      "Manual broadcast only happens on an explicit /mint, and only while the operator's guard is ON.",
      "Auto-mint only acts on YOUR OWN key, only for opportunities that already passed policy, and only while the operator's guard is ON.",
    ].join("\n");
  }

  private async status(): Promise<string> {
    const prepared = await this.deps.prepared.list();
    const users = await this.deps.users.list();
    const autoUsers = this.deps.keystore ? (await this.deps.keystore.listEnabled()).length : 0;
    const lines = [
      "Free Mint Engine — status",
      `chains: ${this.deps.chainsEnabled.join(", ") || "none"}`,
      `fleet wallets: ${this.deps.relay ? this.deps.relay.fleetSize : 0} · executor: ${this.deps.executor?.address ?? "(none)"}`,
      `guard: ${this.deps.guard.get() ? "ON" : "OFF"}`,
      `registered users: ${users.length}`,
      `auto-mint opted in: ${this.deps.keystore ? `${autoUsers} user(s)` : "disabled (operator hasn't configured AUTO_MINT_ENCRYPTION_KEY)"}`,
      `prepared mints: ${prepared.filter((tx) => tx.policy === "PASS").length} PASS / ${prepared.length} total`,
    ];
    return lines.join("\n");
  }

  private async register(chatId: string, args: string[]): Promise<string> {
    const address = args[0];
    if (!address) return "Usage: /register <0x...address>";
    const user = await this.deps.users.register(chatId, address as `0x${string}`);
    return `Registered ${user.address} for this chat. Free mints via /mint will land here. No private key needed.`;
  }

  private async scan(): Promise<string> {
    const processed = await this.deps.scan();
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    const lines = [`Scan complete — processed ${processed} candidate(s).`];
    if (!pass.length) {
      lines.push("No policy-approved free mints found this pass.");
    } else {
      lines.push(`${pass.length} approved mint(s) ready:`, pass.map((tx, i) => formatPrepared(tx, prepared.indexOf(tx))).join("\n"));
    }
    return lines.join("\n");
  }

  private async target(args: string[]): Promise<string> {
    if (!this.deps.target) return "Target checking isn't wired up on this bot.";
    const input = args.join(" ").trim();
    if (!input) return "Usage: /target <0x-address, OpenSea asset URL, Zora URL, or explorer address URL>";
    try {
      return await this.deps.target(input);
    } catch (error) {
      return `TARGET CHECK FAILED: ${(error as Error).message}`;
    }
  }

  private async upcoming(): Promise<string> {
    if (!this.deps.dropStatus) return "Drop status tracking isn't wired up on this bot.";
    const all = await this.deps.dropStatus.list();
    if (!all.length) return "No known drops yet — run /scan a few times to build up the list.";

    const now = Math.floor(Date.now() / 1000);
    const upcoming = all.filter((d) => d.status === "upcoming").sort((a, b) => a.startTime - b.startTime).slice(0, 10);
    const liveFree = all.filter((d) => d.status === "live_free").slice(0, 10);
    const livePaid = all.filter((d) => d.status === "live_paid").slice(0, 5);
    const endedCount = all.filter((d) => d.status === "ended").length;

    if (!upcoming.length && !liveFree.length && !livePaid.length) return "Nothing upcoming or live right now — check back after the next scan.";

    const lines = ["Known drops"];
    if (upcoming.length) lines.push("", `UPCOMING (${upcoming.length}):`, ...upcoming.map((d) => formatDropStatus(d, now)));
    if (liveFree.length) lines.push("", `LIVE & FREE (${liveFree.length}):`, ...liveFree.map((d) => formatDropStatus(d, now)));
    if (livePaid.length) lines.push("", `LIVE, NOT FREE (${livePaid.length}):`, ...livePaid.map((d) => formatDropStatus(d, now)));
    if (endedCount) lines.push("", `${endedCount} ended drop(s) not shown.`);
    return lines.join("\n");
  }

  private async prepared(): Promise<string> {
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (!pass.length) return "No prepared mints. Run /scan first.";
    return pass.map((tx) => formatPrepared(tx, prepared.indexOf(tx))).join("\n");
  }

  private async mint(chatId: string, args: string[]): Promise<string> {
    if (!this.deps.guard.get()) return "Execution guard is OFF. Run /ack on to enable live broadcasting.";
    const index = Number(args[0]);
    if (!Number.isInteger(index) || index < 0) return "Usage: /mint <index> (see /prepared for indexes).";
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (index >= pass.length) return `Index ${index} out of range (${pass.length} prepared).`;
    const tx = pass[index];
    try {
      if (this.deps.relay) {
        const user = await this.deps.users.addressFor(chatId);
        if (!user) return "You haven't registered a receive address. Run /register <0x...address> first.";
        const result = await this.deps.relay.mintFor(user, tx);
        return [
          `MINTING contract ${tx.to}`,
          `minted by fleet wallet: ${result.mintWallet}`,
          `mint TX: ${result.mintTx}`,
          `tokenId: ${result.tokenId?.toString() ?? "?"}`,
          `transferred to you: ${user}`,
          `transfer TX: ${result.transferTx}`,
        ].join("\n");
      }
      if (!this.deps.executor) return "No executor configured. Set EXECUTION_PRIVATE_KEY (or a relay fleet).";
      // No fleet configured means this mints straight from the operator's own funded
      // key with no per-user benefit — keep it admin-only so a stranger can't drain it.
      if (!this.authorized(chatId)) return "This bot has no relay fleet configured, so /mint would spend the operator's own wallet. Restricted to the operator.";
      const { txHash } = await this.deps.executor.execute(tx);
      const receipt = await this.deps.executor.verify(txHash, tx);
      return [
        `MINTING contract ${tx.to}`,
        `TX: ${txHash}`,
        `status: ${receipt.success ? "success" : "failed"} · owner confirmed: ${receipt.ownerConfirmed}`,
        `gas used: ${receipt.gasUsed?.toString() ?? "?"}`,
      ].join("\n");
    } catch (error) {
      return `MINT ABORTED: ${(error as Error).message}`;
    }
  }

  private async sign(chatId: string, args: string[]): Promise<string> {
    if (!this.deps.nonCustodial) return "Non-custodial relay not configured.";
    const index = Number(args[0]);
    if (!Number.isInteger(index) || index < 0) return "Usage: /sign <index> (see /prepared for indexes).";
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (index >= pass.length) return `Index ${index} out of range (${pass.length} prepared).`;
    const tx = pass[index];
    const user = await this.deps.users.addressFor(chatId);
    if (!user) return "You haven't registered a receive address. Run /register <0x...address> first.";
    try {
      const signable = await this.deps.nonCustodial.buildMintTransaction(user, tx);
      return [
        `SIGN THIS IN YOUR WALLET — free mint ${tx.to}`,
        `chain: ${signable.chainId} · from (you): ${user}`,
        `to: ${signable.to}`,
        `value: ${signable.value.toString()} wei · gas: ${signable.gas.toString()} · gasPrice: ${signable.gasPriceWei} wei`,
        `est cost: ${signable.estimatedCostNative} wei`,
        `nonce: ${signable.nonce}`,
        `unsigned: \`${signable.unsignedHex}\``,
        "",
        "Sign this with your own wallet, then /submit <signed-raw-tx>. Your private key never leaves your device.",
      ].join("\n");
    } catch (error) {
      return `SIGN ABORTED: ${(error as Error).message}`;
    }
  }

  private async submit(chatId: string, args: string[]): Promise<string> {
    if (!this.deps.nonCustodial) return "Non-custodial relay not configured.";
    const signed = args[0];
    if (!signed || !signed.startsWith("0x")) return "Usage: /submit <signed-raw-tx> (from /sign).";
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (!pass.length) return "No prepared mints. Run /scan first.";
    const tx = pass[pass.length - 1];
    const user = await this.deps.users.addressFor(chatId);
    if (!user) return "You haven't registered a receive address. Run /register <0x...address> first.";
    try {
      const result = await this.deps.nonCustodial.submitSignedTransaction(user, tx, signed as `0x${string}`);
      return [
        "SUBMITTED (non-custodial)",
        `TX: ${result.txHash}`,
        `status: ${result.success ? "success" : "failed"}`,
        `NFT in your wallet: before ${result.ownedBefore?.toString() ?? "?"} → after ${result.ownedAfter?.toString() ?? "?"}`,
        `gas used: ${result.gasUsed?.toString() ?? "?"}`,
      ].join("\n");
    } catch (error) {
      return `SUBMIT ABORTED: ${(error as Error).message}`;
    }
  }

  private async mintAll(): Promise<string> {
    if (!this.deps.executor) return "No wallet configured. Set EXECUTION_PRIVATE_KEY.";
    if (!this.deps.guard.get()) return "Execution guard is OFF. Run /ack on to enable live broadcasting.";
    const prepared = await this.deps.prepared.list();
    const pass = prepared.filter((tx) => tx.policy === "PASS");
    if (!pass.length) return "No prepared mints. Run /scan first.";
    try {
      const results = await this.deps.executor.executeBatch(pass);
      return [
        "BATCH MINT via EIP-7702",
        ...results.map((result) => `  chain ${result.chainId}: ${result.count} mint(s) · TX ${result.txHash}`),
      ].join("\n");
    } catch (error) {
      return `BATCH MINT ABORTED: ${(error as Error).message}`;
    }
  }

  private async autokey(chatId: string, args: string[], meta: { messageId?: number; chatType?: string }): Promise<string> {
    if (!this.deps.keystore) return "Auto-mint isn't enabled on this bot (operator hasn't configured AUTO_MINT_ENCRYPTION_KEY).";
    if (meta.chatType && meta.chatType !== "private") return "For your safety, run /autokey in a private DM with this bot, not a group chat.";
    const key = args[0];
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return "Usage: /autokey <0x-private-key>. Use a burner wallet with minimal funds — never your main wallet.";
    try {
      const address = await this.deps.keystore.setKey(chatId, key as `0x${string}`);
      if (meta.messageId !== undefined) this.api("deleteMessage", { chat_id: chatId, message_id: meta.messageId }).catch(() => {});
      return [
        `Burner wallet registered: ${address}`,
        "Auto-mint is OFF by default — run /auto on to enable it.",
        "I tried to delete the message containing your key; please also delete it yourself if it's still visible in this chat.",
        "Fund this address with only what you're willing to lose. Once /auto is on, it will sign and broadcast for policy-approved mints without asking you first.",
      ].join("\n");
    } catch (error) {
      return `Could not save key: ${(error as Error).message}`;
    }
  }

  private async auto(chatId: string, args: string[]): Promise<string> {
    if (!this.deps.keystore) return "Auto-mint isn't enabled on this bot.";
    const value = args[0]?.toLowerCase();
    if (value !== "on" && value !== "off") return "Usage: /auto <on|off>";
    if (value === "on" && !(await this.deps.keystore.hasKey(chatId))) return "Register a burner wallet first with /autokey <privatekey>.";
    await this.deps.keystore.setAutoMint(chatId, value === "on");
    return value === "on"
      ? "Auto-mint is now ON. Policy-approved free mints will be signed and broadcast from your burner wallet automatically — no further action needed from you."
      : "Auto-mint is now OFF.";
  }

  private async autostatus(chatId: string): Promise<string> {
    if (!this.deps.keystore) return "Auto-mint isn't enabled on this bot.";
    const address = await this.deps.keystore.addressFor(chatId);
    if (!address) return "No burner wallet registered. Use /autokey <privatekey>.";
    const enabled = await this.deps.keystore.isAutoMintEnabled(chatId);
    return `Burner wallet: ${address}\nAuto-mint: ${enabled ? "ON" : "OFF"}`;
  }

  private async forgetkey(chatId: string): Promise<string> {
    if (!this.deps.keystore) return "Auto-mint isn't enabled on this bot.";
    await this.deps.keystore.removeKey(chatId);
    return "Burner wallet key deleted and auto-mint disabled.";
  }

  private async ack(args: string[]): Promise<string> {
    const value = args[0]?.toLowerCase();
    if (value !== "on" && value !== "off") return "Usage: /ack <on|off>";
    await this.deps.guard.set(value === "on");
    return `Execution guard is now ${value === "on" ? "ON" : "OFF"}.`;
  }

  async run(): Promise<void> {
    while (!this.stop) {
      try {
        const result = await this.api("getUpdates", { offset: this.offset, timeout: 50 }) as { result: { update_id: number; message?: { message_id: number; chat: { id: number; type?: string }; text?: string } }[] };
        for (const update of result.result ?? []) {
          this.offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;
          const chatId = String(message.chat.id);
          const parsed = parseCommand(message.text);
          if (!parsed) continue;
          if (ADMIN_ONLY_COMMANDS.has(parsed.command) && !this.authorized(chatId)) {
            await this.send(chatId, "This command is restricted to the bot operator.");
            continue;
          }
          try {
            const reply = await this.handleCommand(chatId, parsed, { messageId: message.message_id, chatType: message.chat.type });
            await this.send(chatId, reply, TelegramCommandBot.COMMANDS_WITH_LINK_PREVIEW.has(parsed.command));
          } catch (error) {
            await this.send(chatId, `ERROR: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        console.error("Telegram poll error:", (error as Error).message);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  stopLoop(): void { this.stop = true; }
}
