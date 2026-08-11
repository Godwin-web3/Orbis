import type { NotificationSink } from "../domain/ports";

export class TelegramNotificationSink implements NotificationSink {
  readonly name = "telegram";
  constructor(private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? "", private readonly chatId = process.env.TELEGRAM_CHAT_ID ?? "") {}

  async send(message: string): Promise<void> {
    if (!this.token || !this.chatId) return;
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: this.chatId, text: message, disable_web_page_preview: true }) });
    if (!response.ok) throw new Error(`Telegram notification failed: ${response.status}`);
  }
}
