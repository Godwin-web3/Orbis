import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildRuntime } from "../src/app/runtime";
import { JsonlPreparedTransactionStore } from "../src/execution/prepared";
import { RpcExecutor } from "../src/execution/executor";
import { WalletFleet, MintRelay } from "../src/execution/relay";
import { NonCustodialRelay } from "../src/execution/noncustodial";
import { JsonlUserRegistry } from "../src/users/registry";
import { TelegramCommandBot } from "../src/telegram/bot";
import { enabledChains } from "../config/chains";

const GUARD_PATH = process.env.GUARD_STATE_PATH ?? "data/guard.json";

async function loadGuard(): Promise<boolean> {
  try { return JSON.parse(await readFile(GUARD_PATH, "utf8")).enabled === true; } catch { return false; }
}
async function saveGuard(value: boolean): Promise<void> {
  await mkdir(dirname(GUARD_PATH), { recursive: true });
  await writeFile(GUARD_PATH, JSON.stringify({ enabled: value, updatedAt: new Date().toISOString() }));
}

function splitKeys(value: string): string[] {
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const allowed = (process.env.TELEGRAM_ADMIN_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN (create a bot via @BotFather).");
  if (!allowed.length) throw new Error("Set TELEGRAM_ADMIN_IDS (or TELEGRAM_CHAT_ID) to authorize a user.");

  const fleetKeys = splitKeys(process.env.FLEET_PRIVATE_KEYS ?? "");
  const relay = fleetKeys.length ? new MintRelay(new WalletFleet(fleetKeys)) : undefined;

  const privKey = process.env.EXECUTION_PRIVATE_KEY ?? "";
  const executor = privKey ? new RpcExecutor(privKey) : undefined;
  const nonCustodial = new NonCustodialRelay();
  const prepared = new JsonlPreparedTransactionStore(process.env.PREPARED_LOG ?? "data/prepared-transactions.jsonl");
  const users = new JsonlUserRegistry(process.env.USER_REGISTRY_PATH ?? "data/users.jsonl");
  const chainsEnabled = enabledChains().map((chain) => chain.key);
  let guardEnabled = await loadGuard();
  const guard = { get: () => guardEnabled, set: async (value: boolean) => { guardEnabled = value; await saveGuard(value); } };

  const bot = new TelegramCommandBot(token, allowed, {
    prepared,
    executor,
    relay,
    nonCustodial,
    users,
    chainsEnabled,
    guard,
    scan: async () => {
      const engine = buildRuntime();
      const result = await engine.run();
      return result.count;
    },
  });

  console.log(`Telegram bot started. Authorized chats: ${allowed.join(", ")}. Relay fleet: ${relay?.fleet.size ?? 0} wallet(s). Executor: ${executor?.address ?? "(none)"}`);
  await bot.run();
}

main().catch((error) => { console.error(error); process.exit(1); });
