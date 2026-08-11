import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildRuntime } from "../src/app/runtime";
import type { CandidateReport } from "../src/core/report";
import { chains } from "../config/chains";

const ALERTED_LOG = process.env.ALERTED_LOG ?? "data/alerted.jsonl";

async function loadAlerted(): Promise<Set<string>> {
  try {
    return new Set((await readFile(ALERTED_LOG, "utf8")).split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

async function markAlerted(id: string): Promise<void> {
  await mkdir(dirname(ALERTED_LOG), { recursive: true });
  await appendFile(ALERTED_LOG, `${id}\n`);
}

async function api(token: string, method: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
}

function displayName(result: CandidateReport): string {
  const name = result.candidate.metadata?.name ?? result.candidate.metadata?.collectionName ?? result.candidate.metadata?.title;
  return typeof name === "string" && name ? name : result.candidate.contract;
}

function explorerMintLink(chainKey: string, contract: string): string {
  const explorer = chains[chainKey]?.explorer;
  return explorer ? `${explorer}/address/${contract}#writeContract` : "";
}

function formatAlert(result: CandidateReport): string {
  const chain = chains[result.candidate.chainKey];
  const chainName = chain?.nativeSymbol ? `${chain.key[0].toUpperCase()}${chain.key.slice(1)} (${chain.nativeSymbol})` : result.candidate.chainKey;
  const mintFunction = result.transaction?.mintFunction ?? result.candidate.mintFunction ?? "publicMint";
  const gas = result.simulation.gasEstimate;
  const link = explorerMintLink(result.candidate.chainKey, result.candidate.contract);
  const lines = [
    "🟢 FREE MINT FOUND",
    "",
    `Collection: ${displayName(result)}`,
    `Chain: ${chainName}`,
    `Contract: \`${result.candidate.contract}\``,
    `Mint: \`${mintFunction}\``,
  ];
  if (gas) lines.push(`Gas est: ${gas}`);
  if (result.transaction) lines.push(`Policy: ${result.transaction.policy}`);
  lines.push("");
  if (link) {
    lines.push(`🔗 Mint link (connect your wallet): ${link}`);
    lines.push("");
    lines.push("⚠️ Always verify the contract yourself before minting.");
  } else {
    lines.push("⚠️ Connect your wallet and call the mint function directly. No contract explorer link configured for this chain.");
  }
  return lines.join("\n");
}

async function main() {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const channelId = process.env.TELEGRAM_ALERT_CHANNEL_ID ?? process.env.TELEGRAM_CHAT_ID ?? "";
  if (!token) throw new Error("Set TELEGRAM_ALERT_BOT_TOKEN (or TELEGRAM_BOT_TOKEN).");
  if (!channelId) throw new Error("Set TELEGRAM_ALERT_CHANNEL_ID (or TELEGRAM_CHAT_ID) to a public channel where alerts are posted.");

  const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS ?? "120000");
  let alerted = await loadAlerted();

  console.log(`Discovery bot started. Posting alerts to chat ${channelId}. Scan interval ${scanIntervalMs}ms.`);

  async function runScan(): Promise<void> {
    const engine = buildRuntime();
    const { results } = await engine.run();
    const pass = results.filter((result) => result.decision === "PASS" && !alerted.has(result.candidate.id));
    for (const result of pass) {
      await api(token, "sendMessage", { chat_id: channelId, text: formatAlert(result), disable_web_page_preview: false });
      alerted.add(result.candidate.id);
      await markAlerted(result.candidate.id);
      console.log(`Alerted ${result.candidate.id} (${displayName(result)})`);
    }
    if (!pass.length) console.log("Scan complete. No new policy-approved free mints.");
  }

  await runScan();
  setInterval(runScan, scanIntervalMs).unref();
}

main().catch((error) => { console.error(error); process.exit(1); });
