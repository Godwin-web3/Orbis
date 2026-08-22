import type { SupabaseClient } from "@supabase/supabase-js";
import { buildRuntime, urlsFor } from "../src/app/runtime";
import { RpcExecutor } from "../src/execution/executor";
import { WalletFleet, MintRelay } from "../src/execution/relay";
import { NonCustodialRelay } from "../src/execution/noncustodial";
import { AutoMintLoop } from "../src/execution/automint";
import { ConsoleNotificationSink } from "../src/notifications/console";
import { parseEncryptionKey } from "../src/users/crypto";
import { parseTargetInput, processTarget } from "../src/discovery/target";
import {
  createSupabaseClient,
  loadGuardState,
  saveGuardState,
  SupabaseAutoMintLog,
  SupabaseBlockCursorStore,
  SupabaseCandidateStore,
  SupabasePreparedTransactionStore,
  SupabaseUserKeyStore,
  SupabaseUserRegistry,
} from "../src/storage/supabase";
import { ADMIN_ONLY_COMMANDS, parseCommand, TelegramCommandBot, type ParsedCommand } from "../src/telegram/bot";
import { enabledChains } from "../config/chains";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ADMIN_IDS: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  AUTO_MINT_ENCRYPTION_KEY?: string;
  FLEET_PRIVATE_KEYS?: string;
  EXECUTION_PRIVATE_KEY?: string;
  BATCH_EXECUTOR_ADDRESS?: string;
  AUTO_MINT_MAX_PER_USER_PER_SCAN?: string;
  AUTO_MINT_MAX_TOTAL_PER_SCAN?: string;
  [key: string]: string | undefined;
}

type TelegramMessage = { message_id: number; chat: { id: number; type?: string }; text?: string };
type TelegramUpdate = { message?: TelegramMessage };

/** Bridges Worker env bindings into process.env for the ~unmodified engine/execution code, which reads config via process.env throughout (RPC URLs, contract lists, etc). Requires the nodejs_compat flag in wrangler.toml. */
function populateProcessEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
}

function splitKeys(value: string): string[] {
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

function adminIdsFrom(env: Env): string[] {
  return splitKeys(env.TELEGRAM_ADMIN_IDS ?? "");
}

async function buildBot(env: Env, db: SupabaseClient): Promise<TelegramCommandBot> {
  const prepared = new SupabasePreparedTransactionStore(db);
  const users = new SupabaseUserRegistry(db);
  const keystore = env.AUTO_MINT_ENCRYPTION_KEY ? new SupabaseUserKeyStore(db, parseEncryptionKey(env.AUTO_MINT_ENCRYPTION_KEY)) : undefined;
  const fleetKeys = splitKeys(env.FLEET_PRIVATE_KEYS ?? "");
  const relay = fleetKeys.length ? new MintRelay(new WalletFleet(fleetKeys)) : undefined;
  const executor = env.EXECUTION_PRIVATE_KEY ? new RpcExecutor(env.EXECUTION_PRIVATE_KEY) : undefined;
  const nonCustodial = new NonCustodialRelay();
  const chainsEnabled = enabledChains().map((chain) => chain.key);

  let guardEnabled = await loadGuardState(db);
  const guard = { get: () => guardEnabled, set: async (value: boolean) => { guardEnabled = value; await saveGuardState(db, value); } };

  return new TelegramCommandBot(env.TELEGRAM_BOT_TOKEN, adminIdsFrom(env), {
    prepared,
    executor,
    relay,
    nonCustodial,
    users,
    keystore,
    chainsEnabled,
    guard,
    scan: async () => {
      const engine = buildRuntime({
        candidateStore: new SupabaseCandidateStore(db),
        preparedStore: prepared,
        notifications: [new ConsoleNotificationSink()],
        blockCursor: new SupabaseBlockCursorStore(db),
      });
      const result = await engine.run();
      return result.count;
    },
    target: async (input: string) => {
      const defaultChainKey = chainsEnabled[0];
      const resolved = parseTargetInput(input, defaultChainKey);
      if (!resolved) return "Couldn't figure out the chain/contract from that. Paste the raw 0x contract address, or use an OpenSea asset, Zora, or block-explorer URL.";
      if (!chainsEnabled.includes(resolved.chainKey)) return `Chain "${resolved.chainKey}" isn't enabled. Enabled: ${chainsEnabled.join(", ") || "none"}.`;
      const engine = buildRuntime({
        candidateStore: new SupabaseCandidateStore(db),
        preparedStore: prepared,
        notifications: [new ConsoleNotificationSink()],
        blockCursor: new SupabaseBlockCursorStore(db),
        chainKeys: [resolved.chainKey],
      });
      return processTarget(engine, urlsFor(resolved.chainKey), resolved);
    },
  });
}

async function handleUpdate(bot: TelegramCommandBot, chatId: string, parsed: ParsedCommand, message: TelegramMessage): Promise<void> {
  try {
    const reply = await bot.handleCommand(chatId, parsed, { messageId: message.message_id, chatType: message.chat.type });
    await bot.sendTo(chatId, reply);
  } catch (error) {
    await bot.sendTo(chatId, `ERROR: ${(error as Error).message}`);
  }
}

/** Cron-triggered pass: discover+simulate+prepare, then attempt auto-mint for every opted-in user. Replaces the setInterval loops used in the always-on process (scripts/discovery-bot.ts, AutoMintLoop.start) — Workers has no persistent process to run them in. */
async function runScheduledPass(env: Env): Promise<void> {
  const db = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const preparedStore = new SupabasePreparedTransactionStore(db);

  try {
    const engine = buildRuntime({
      candidateStore: new SupabaseCandidateStore(db),
      preparedStore,
      notifications: [new ConsoleNotificationSink()],
      blockCursor: new SupabaseBlockCursorStore(db),
    });
    await engine.run();
  } catch (error) {
    console.error("scheduled scan failed:", (error as Error).message);
  }

  if (!env.AUTO_MINT_ENCRYPTION_KEY) return;

  const bot = await buildBot(env, db);
  const keystore = new SupabaseUserKeyStore(db, parseEncryptionKey(env.AUTO_MINT_ENCRYPTION_KEY));
  const guardEnabled = await loadGuardState(db);
  const loop = new AutoMintLoop({
    prepared: preparedStore,
    keystore,
    guard: { get: () => guardEnabled },
    log: new SupabaseAutoMintLog(db),
    caps: {
      maxPerUserPerScan: Number(env.AUTO_MINT_MAX_PER_USER_PER_SCAN ?? "1"),
      maxTotalPerScan: Number(env.AUTO_MINT_MAX_TOTAL_PER_SCAN ?? "10"),
    },
    notify: (userId, text) => bot.sendTo(userId, text),
    onError: (error) => console.error("automint error:", (error as Error).message),
  });
  await loop.runOnce();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    populateProcessEnv(env);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") return new Response("Orbis webhook bot is running.");
    if (request.method !== "POST" || url.pathname !== "/telegram-webhook") return new Response("Not found", { status: 404 });

    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message;
    if (!message?.text) return new Response("ok");

    const parsed = parseCommand(message.text);
    if (!parsed) return new Response("ok");

    const chatId = String(message.chat.id);
    const db = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const bot = await buildBot(env, db);

    if (ADMIN_ONLY_COMMANDS.has(parsed.command) && !adminIdsFrom(env).includes(chatId)) {
      ctx.waitUntil(bot.sendTo(chatId, "This command is restricted to the bot operator."));
      return new Response("ok");
    }

    // Ack Telegram immediately (it retries webhooks that don't return fast); the actual
    // reply is delivered separately via sendMessage once the command finishes.
    ctx.waitUntil(handleUpdate(bot, chatId, parsed, message));
    return new Response("ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    populateProcessEnv(env);
    ctx.waitUntil(runScheduledPass(env));
  },
};
