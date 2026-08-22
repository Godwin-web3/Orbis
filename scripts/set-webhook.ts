const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token || !workerUrl || !secret) {
  throw new Error("Set TELEGRAM_BOT_TOKEN, WORKER_URL (e.g. https://orbis-telegram-bot.<subdomain>.workers.dev), and TELEGRAM_WEBHOOK_SECRET.");
}

const url = `${workerUrl.replace(/\/$/, "")}/telegram-webhook`;

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"] }),
});
const result = (await response.json()) as { ok: boolean; description?: string };
console.log(result);
if (!result.ok) {
  console.error(`Telegram rejected the webhook: ${result.description ?? "unknown error"}`);
  process.exit(1);
}
console.log(`Webhook set to ${url}`);
