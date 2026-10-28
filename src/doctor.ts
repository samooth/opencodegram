import { loadConfig } from "./config.js";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";

async function main() {
  const config = loadConfig();
  console.log("config: ok");
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const me = await tg.getMe();
  console.log(`telegram: @${me.username ?? me.first_name} (id ${me.id}) topics=${me.has_topics_enabled ?? false}`);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());
  const info = await oc.serverInfo();
  console.log("opencode:", JSON.stringify(info));
  const sessions = await oc.listSessions();
  console.log("sessions:", Array.isArray(sessions) ? sessions.length : JSON.stringify(sessions).slice(0, 200));
  console.log("doctor: ok");
}

main().catch((err) => {
  console.error("doctor: failed", err);
  process.exit(1);
});