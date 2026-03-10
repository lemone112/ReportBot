/**
 * Usage: node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL>
 * Example: node scripts/set-webhook.mjs 123456:ABC-DEF https://bug-reporter-bot.your-subdomain.workers.dev
 */

const [, , token, workerUrl] = process.argv;

if (!token || !workerUrl) {
  console.error("Usage: node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL>");
  process.exit(1);
}

const webhookUrl = `${workerUrl.replace(/\/$/, "")}/webhook`;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    allowed_updates: ["message"],
  }),
});

const data = await res.json();
console.log("Set webhook result:", JSON.stringify(data, null, 2));
