const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN.");

const response = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST" });
console.log(await response.json());
console.log("Webhook removed. Switch back to bun run telegram-bot (long-polling) if needed.");
