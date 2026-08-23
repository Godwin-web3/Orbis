import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildRuntime, urlsFor } from "../src/app/runtime";
import { JsonlPreparedTransactionStore } from "../src/execution/prepared";
import { RpcExecutor } from "../src/execution/executor";
import { WalletFleet, MintRelay } from "../src/execution/relay";
import { NonCustodialRelay } from "../src/execution/noncustodial";
import { AutoMintLoop, JsonlAutoMintLog } from "../src/execution/automint";
import { JsonlUserRegistry } from "../src/users/registry";
import { JsonlUserKeyStore, parseEncryptionKey } from "../src/users/keystore";
import { TelegramCommandBot } from "../src/telegram/bot";
import { parseTargetInput, processTarget } from "../src/discovery/target";
import { JsonlDropStatusStore } from "../src/discovery/rpc/drop-status";
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
  const dropStatusStore = new JsonlDropStatusStore(process.env.DROP_STATUS_PATH ?? "data/drop-status.json");
  const chainsEnabled = enabledChains().map((chain) => chain.key);
  let guardEnabled = await loadGuard();
  const guard = { get: () => guardEnabled, set: async (value: boolean) => { guardEnabled = value; await saveGuard(value); } };

  const encryptionKeyHex = process.env.AUTO_MINT_ENCRYPTION_KEY ?? "";
  const keystore = encryptionKeyHex
    ? new JsonlUserKeyStore(process.env.AUTO_MINT_KEYSTORE_PATH ?? "data/automint-keys.jsonl", parseEncryptionKey(encryptionKeyHex))
    : undefined;

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
      const engine = buildRuntime({ dropStatusStore });
      const result = await engine.run();
      return result.count;
    },
    target: async (input: string) => {
      const defaultChainKey = chainsEnabled[0];
      const resolved = parseTargetInput(input, defaultChainKey);
      if (!resolved) return "Couldn't figure out the chain/contract from that. Paste the raw 0x contract address, or use an OpenSea asset, Zora, or block-explorer URL.";
      if (!chainsEnabled.includes(resolved.chainKey)) return `Chain "${resolved.chainKey}" isn't enabled. Enabled: ${chainsEnabled.join(", ") || "none"}.`;
      const engine = buildRuntime({ dropStatusStore, chainKeys: [resolved.chainKey] });
      return processTarget(engine, urlsFor(resolved.chainKey), resolved);
    },
  });

  let autoMintLoop: AutoMintLoop | undefined;
  if (keystore) {
    autoMintLoop = new AutoMintLoop({
      prepared,
      keystore,
      guard,
      log: new JsonlAutoMintLog(process.env.AUTO_MINT_LOG_PATH ?? "data/automint-log.jsonl"),
      caps: {
        maxPerUserPerScan: Number(process.env.AUTO_MINT_MAX_PER_USER_PER_SCAN ?? "1"),
        maxTotalPerScan: Number(process.env.AUTO_MINT_MAX_TOTAL_PER_SCAN ?? "10"),
      },
      notify: (userId, text) => bot.sendTo(userId, text),
      onError: (error) => console.error("Auto-mint loop error:", (error as Error).message),
    });
    autoMintLoop.start(Number(process.env.AUTO_MINT_SCAN_INTERVAL_MS ?? "120000"));
  }

  console.log(
    `Telegram bot started. Authorized chats: ${allowed.join(", ")}. Relay fleet: ${relay?.fleet.size ?? 0} wallet(s). Executor: ${executor?.address ?? "(none)"}. Auto-mint: ${autoMintLoop ? "enabled (users opt in with /autokey + /auto on)" : "disabled (set AUTO_MINT_ENCRYPTION_KEY to enable)"}`,
  );
  await bot.run();
}

main().catch((error) => { console.error(error); process.exit(1); });
