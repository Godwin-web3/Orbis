import type { PreparedTransactionStore } from "../domain/ports";
import type { PreparedTransaction } from "../domain/types";
import type { RpcExecutor } from "../execution/executor";
import type { UserRegistry } from "../users/registry";
import type { MintRelay } from "../execution/relay";
import type { NonCustodialRelay } from "../execution/noncustodial";

export type ParsedCommand = { command: string; args: string[] };
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;
  return { command: head.split("@")[0].toLowerCase(), args: rest };
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
      guard: { get(): boolean; set(value: boolean): Promise<void> };
      scan: () => Promise<number>;
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

  private async send(chatId: string, text: string): Promise<void> {
    const chunks = text.match(/.{1,4000}(?:\s|$)/g) ?? [text];
    for (const chunk of chunks) await this.api("sendMessage", { chat_id: chatId, text: chunk, disable_web_page_preview: true });
  }

  private authorized(chatId: string): boolean { return this.allowedChatIds.includes(chatId); }

  async handleCommand(chatId: string, parsed: ParsedCommand): Promise<string> {
    switch (parsed.command) {
      case "help": return this.help();
      case "status": return this.status();
      case "register": return this.register(chatId, parsed.args);
      case "scan": return this.scan();
      case "prepared": return this.prepared();
      case "mint": return this.mint(chatId, parsed.args);
      case "sign": return this.sign(chatId, parsed.args);
      case "submit": return this.submit(chatId, parsed.args);
      case "mint-all": case "mintall": return this.mintAll();
      case "ack": return this.ack(parsed.args);
      default: return `Unknown command /${parsed.command}. Send /help.`;
    }
  }

  private help(): string {
    return [
      "Free Mint Engine — Telegram controls",
      "/register <address> — set the wallet this chat receives NFTs in (no private key needed)",
      "/status — wallet, chains, guard, registered users, prepared count",
      "/scan — run a discovery+simulation+prepare pass",
      "/prepared — list mints ready to broadcast",
      "/mint <index> — mint to YOUR registered address (re-verifies free/open/limit)",
      "/sign <index> — build the EXACT transaction for your wallet to sign (non-custodial; you keep your key)",
      "/submit <signed-raw-tx> — relay a tx you signed in your own wallet; the NFT lands in your wallet",
      "/mint-all — batch-broadcast ALL prepared mints in one EIP-7702 tx per chain",
      "/ack <on|off> — enable/disable live execution guard",
      "/help — this message",
      "",
      "Broadcast only happens on an explicit /mint. The guard must be ON.",
    ].join("\n");
  }

  private async status(): Promise<string> {
    const prepared = await this.deps.prepared.list();
    const users = await this.deps.users.list();
    const lines = [
      "Free Mint Engine — status",
      `chains: ${this.deps.chainsEnabled.join(", ") || "none"}`,
      `fleet wallets: ${this.deps.relay ? this.deps.relay.fleetSize : 0} · executor: ${this.deps.executor?.address ?? "(none)"}`,
      `guard: ${this.deps.guard.get() ? "ON" : "OFF"}`,
      `registered users: ${users.length}`,
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

  private async ack(args: string[]): Promise<string> {
    const value = args[0]?.toLowerCase();
    if (value !== "on" && value !== "off") return "Usage: /ack <on|off>";
    await this.deps.guard.set(value === "on");
    return `Execution guard is now ${value === "on" ? "ON" : "OFF"}.`;
  }

  async run(): Promise<void> {
    while (!this.stop) {
      try {
        const result = await this.api("getUpdates", { offset: this.offset, timeout: 50 }) as { result: { update_id: number; message?: { chat: { id: number }; text?: string } }[] };
        for (const update of result.result ?? []) {
          this.offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text) continue;
          const chatId = String(message.chat.id);
          if (!this.authorized(chatId)) continue;
          const parsed = parseCommand(message.text);
          if (!parsed) continue;
          try {
            const reply = await this.handleCommand(chatId, parsed);
            await this.send(chatId, reply);
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
