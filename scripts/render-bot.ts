// Always-on Telegram bot for a persistent host (deployed as a Render free Web Service, or
// any other machine that can run a long-lived Bun process) — real on-chain discovery work
// (ABI encoding, checksum validation, decoding responses across multiple chains) needs a
// genuine persistent process, not a platform metered in milliseconds of CPU time per
// request. Same command set as scripts/telegram-bot.ts, but Supabase-backed throughout
// instead of local JSONL files, since a Render service's disk isn't guaranteed to persist
// across restarts/redeploys the way a real server's would. Also runs the periodic discovery
// scan + auto-mint loop directly via setInterval, since a persistent process can just do that.
//
// Render's free tier only applies to "Web Service" instances (Background Workers require
// a paid plan), and a Web Service needs to actually serve HTTP — Render marks it unhealthy,
// and free web services spin down after 15 minutes with no *inbound* request, which is all
// this process ever gets since it talks to Telegram via outbound long-polling, never an
// inbound webhook. minimalHealthServer() below exists purely so Render sees a live port;
// something external needs to hit it periodically to prevent that spin-down (see the
// GitHub Actions keep-alive workflow, .github/workflows/render-keepalive.yml).
function minimalHealthServer(): void {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: () => new Response("Orbis bot is running.") });
  console.log(`Health server listening on :${port} (keeps Render's free Web Service plan from marking this unhealthy).`);
}
import { buildRuntime, urlsFor } from "../src/app/runtime";
import { RpcExecutor } from "../src/execution/executor";
import { WalletFleet, MintRelay } from "../src/execution/relay";
import { NonCustodialRelay } from "../src/execution/noncustodial";
import { AutoMintLoop } from "../src/execution/automint";
import { SnipeScheduler } from "../src/execution/snipe";
import { ConsoleNotificationSink } from "../src/notifications/console";
import { parseEncryptionKey } from "../src/users/crypto";
import { parseTargetInput, processTarget, checkSeaDropTarget } from "../src/discovery/target";
import { TelegramCommandBot } from "../src/telegram/bot";
import { chains, enabledChains } from "../config/chains";
import {
  createSupabaseClient,
  loadGuardState,
  saveGuardState,
  SupabaseAutoMintLog,
  SupabaseBlockCursorStore,
  SupabaseCandidateStore,
  SupabaseContractRegistry,
  SupabaseDropStatusStore,
  SupabasePreparedTransactionStore,
  SupabaseUserKeyStore,
  SupabaseUserRegistry,
} from "../src/storage/supabase";

function splitKeys(value: string): string[] {
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

async function main() {
  minimalHealthServer();
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const allowed = (process.env.TELEGRAM_ADMIN_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN (create a bot via @BotFather).");
  if (!allowed.length) throw new Error("Set TELEGRAM_ADMIN_IDS (or TELEGRAM_CHAT_ID) to authorize a user.");
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !supabaseKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");

  const db = createSupabaseClient(supabaseUrl, supabaseKey);
  const prepared = new SupabasePreparedTransactionStore(db);
  const users = new SupabaseUserRegistry(db);
  const candidateStore = new SupabaseCandidateStore(db);
  const blockCursor = new SupabaseBlockCursorStore(db);
  const contractRegistry = new SupabaseContractRegistry(db);
  const dropStatusStore = new SupabaseDropStatusStore(db);

  const fleetKeys = splitKeys(process.env.FLEET_PRIVATE_KEYS ?? "");
  const relay = fleetKeys.length ? new MintRelay(new WalletFleet(fleetKeys)) : undefined;
  const privKey = process.env.EXECUTION_PRIVATE_KEY ?? "";
  const executor = privKey ? new RpcExecutor(privKey) : undefined;
  const nonCustodial = new NonCustodialRelay();
  const chainsEnabled = enabledChains().map((chain) => chain.key);

  let guardEnabled = await loadGuardState(db);
  const guard = { get: () => guardEnabled, set: async (value: boolean) => { guardEnabled = value; await saveGuardState(db, value); } };

  const encryptionKeyHex = process.env.AUTO_MINT_ENCRYPTION_KEY ?? "";
  const keystore = encryptionKeyHex ? new SupabaseUserKeyStore(db, parseEncryptionKey(encryptionKeyHex)) : undefined;

  const runtimeOverrides = { candidateStore, preparedStore: prepared, notifications: [new ConsoleNotificationSink()], blockCursor, contractRegistry, dropStatusStore };

  const bot = new TelegramCommandBot(token, allowed, {
    prepared,
    executor,
    relay,
    nonCustodial,
    users,
    keystore,
    chainsEnabled,
    guard,
    dropStatus: dropStatusStore,
    scan: async () => {
      const engine = buildRuntime(runtimeOverrides);
      const result = await engine.run();
      return result.count;
    },
    target: async (input: string) => {
      const defaultChainKey = chainsEnabled[0];
      const resolved = parseTargetInput(input, defaultChainKey);
      if (!resolved) return "Couldn't figure out the chain/contract from that. Paste the raw 0x contract address, or use an OpenSea asset, Zora, or block-explorer URL.";
      if (!chainsEnabled.includes(resolved.chainKey)) return `Chain "${resolved.chainKey}" isn't enabled. Enabled: ${chainsEnabled.join(", ") || "none"}.`;
      const engine = buildRuntime({ ...runtimeOverrides, chainKeys: [resolved.chainKey] });
      return processTarget(engine, urlsFor(resolved.chainKey), resolved);
    },
    snipeTarget: async (input: string) => {
      const defaultChainKey = chainsEnabled[0];
      const resolved = parseTargetInput(input, defaultChainKey);
      if (!resolved) return { error: "Couldn't figure out the chain/contract from that. Paste the raw 0x contract address, or use an OpenSea asset, Zora, or block-explorer URL." };
      if (!chainsEnabled.includes(resolved.chainKey)) return { error: `Chain "${resolved.chainKey}" isn't enabled. Enabled: ${chainsEnabled.join(", ") || "none"}.` };
      return checkSeaDropTarget(urlsFor(resolved.chainKey), resolved);
    },
  });

  const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS ?? "120000");
  async function runScan(): Promise<void> {
    try {
      const engine = buildRuntime(runtimeOverrides);
      const { count } = await engine.run();
      console.log(`Background scan complete: ${count} candidate(s) processed.`);
    } catch (error) {
      console.error("Background scan failed:", (error as Error).message);
    }
  }
  setInterval(runScan, scanIntervalMs).unref();

  let autoMintLoop: AutoMintLoop | undefined;
  let snipeScheduler: SnipeScheduler | undefined;
  if (keystore) {
    const autoMintLog = new SupabaseAutoMintLog(db);
    autoMintLoop = new AutoMintLoop({
      prepared,
      keystore,
      guard,
      log: autoMintLog,
      caps: {
        maxPerUserPerScan: Number(process.env.AUTO_MINT_MAX_PER_USER_PER_SCAN ?? "1"),
        maxTotalPerScan: Number(process.env.AUTO_MINT_MAX_TOTAL_PER_SCAN ?? "10"),
      },
      notify: (userId, text) => bot.sendTo(userId, text),
      onError: (error) => console.error("Auto-mint loop error:", (error as Error).message),
    });
    autoMintLoop.start(Number(process.env.AUTO_MINT_SCAN_INTERVAL_MS ?? "120000"));

    snipeScheduler = new SnipeScheduler({
      dropStatusStore,
      keystore,
      guard,
      log: autoMintLog,
      notify: (userId, text) => bot.sendTo(userId, text),
      rpcUrlsFor: urlsFor,
      chainIdFor: (chainKey) => chains[chainKey]?.chainId,
      armLeadSeconds: Number(process.env.SNIPE_ARM_LEAD_SECONDS ?? "15"),
      onError: (error, context) => console.error(`Snipe scheduler error (${context}):`, (error as Error).message),
    });
    snipeScheduler.start(Number(process.env.SNIPE_TICK_INTERVAL_MS ?? "10000"));
  }

  console.log(
    `Orbis bot started (Supabase-backed). Authorized chats: ${allowed.join(", ")}. Chains: ${chainsEnabled.join(", ") || "none"}. Background scan every ${scanIntervalMs}ms. Relay fleet: ${relay?.fleet.size ?? 0} wallet(s). Executor: ${executor?.address ?? "(none)"}. Auto-mint: ${autoMintLoop ? "enabled (users opt in with /autokey + /auto on)" : "disabled (set AUTO_MINT_ENCRYPTION_KEY to enable)"}. Snipe scheduler: ${snipeScheduler ? "enabled (/snipe to arm a drop ahead of time)" : "disabled (needs AUTO_MINT_ENCRYPTION_KEY)"}`,
  );
  await runScan();
  await bot.run();
}

main().catch((error) => { console.error(error); process.exit(1); });
