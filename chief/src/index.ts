import { createBot, setCommandMenus } from "./bot.js";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

async function main(): Promise<void> {
  logEvent("info", "bot.startup.begin");
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }
  if (!config.nearBuildersApiKey) {
    throw new Error("NEARBUILDERS_API_KEY is not set in .env");
  }
  if (!config.adminChatId) {
    logEvent("warn", "bot.startup.no_admin_chat", {
      outcome: "review_commands_disabled_until_ADMIN_CHAT_ID_is_set",
    });
  }

  const bot = createBot(config.telegramBotToken);
  await setCommandMenus(bot, config.adminChatId);

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    logEvent("info", "bot.shutdown.requested", { signal });
    try {
      bot.stop(signal);
    } catch (error) {
      logEvent("warn", "bot.shutdown.before_polling", { err: error, signal });
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await bot.launch({ allowedUpdates: ["message", "callback_query"] }, () => {
    logEvent("info", "bot.polling.started", { username: bot.botInfo?.username });
  });
}

main().catch((error: unknown) => {
  logEvent("fatal", "bot.startup.failed", { err: error });
  process.exitCode = 1;
});
