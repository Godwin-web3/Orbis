import type { NotificationSink } from "../domain/ports";
import type { CandidateReport } from "../core/report";
import { capitalize, dropLink } from "../chains/registry";

export class TelegramNotificationSink implements NotificationSink {
  readonly name = "telegram";
  constructor(private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? "", private readonly chatId = process.env.TELEGRAM_CHAT_ID ?? "") {}

  async send(message: string): Promise<void> {
    if (!this.token || !this.chatId) return;
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true }) });
    if (!response.ok) throw new Error(`Telegram notification failed: ${response.status}`);
  }
}

/** Formats a short alert for one candidate report, or undefined if it doesn't clear the
 * bar for a push (see TelegramAlertSink). Exported separately so it's unit-testable
 * without a network call. */
export function formatAlert(report: CandidateReport): string | undefined {
  const { candidate, decision, reasons } = report;
  const valueSignal = candidate.metadata.valueSignal === true;
  if (decision !== "PASS" && !valueSignal) return undefined;
  const nftContract = (typeof candidate.metadata.nftContract === "string" ? candidate.metadata.nftContract : candidate.contract) as string;
  const name = typeof candidate.metadata.name === "string" ? candidate.metadata.name : nftContract;
  const link = dropLink(candidate.chainKey, nftContract);
  const recentMints = candidate.metadata.recentMints;
  const floorNative = candidate.metadata.floorNative;
  const signal = recentMints !== undefined ? `${recentMints} mints this window` : floorNative !== undefined ? `floor ${floorNative} ETH` : "demand detected";
  const header = decision === "PASS" ? `🎯 PASS · ${capitalize(candidate.chainKey)}` : `🔥 hot but skipped · ${capitalize(candidate.chainKey)}`;
  return [
    header,
    `  ${name} (${nftContract})`,
    ...(link ? [`  ${link}`] : []),
    `  ${signal}`,
    decision === "PASS" ? "  Run /prepared for the mint index." : `  reasons: ${reasons.join("; ")}`,
  ].join("\n");
}

/** Telegram push for the background scan loop. The raw per-candidate report (see
 * core/report.ts) that engine.ts sends is meant for console/jsonl logging, not a chat —
 * most scans surface several SKIPs with "no demand or floor" nobody needs pinged for.
 * This only forwards a real opportunity (PASS) or a candidate with independent demand
 * evidence (valueSignal, even if policy skipped it for some other reason like gas), and
 * drops everything else silently. */
export class TelegramAlertSink implements NotificationSink {
  readonly name = "telegram-alert";
  constructor(private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? "", private readonly chatId = process.env.TELEGRAM_CHAT_ID ?? "") {}

  async send(message: string): Promise<void> {
    if (!this.token || !this.chatId) return;
    let report: CandidateReport;
    try { report = JSON.parse(message); } catch { return; }
    const text = formatAlert(report);
    if (!text) return;
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: false }) });
    if (!response.ok) throw new Error(`Telegram alert failed: ${response.status}`);
  }
}
