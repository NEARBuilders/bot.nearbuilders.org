import type { Types } from "telegraf";
import { clearCommandMenus, createBot } from "./bot.js";
import { config } from "./config.js";
import { logEvent } from "./logger.js";

const ALL_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
  "chat_boost",
  "removed_chat_boost",
] satisfies Types.UpdateType[];

async function main(): Promise<void> {
  logEvent("info", "bot.startup.begin");
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }
  if (!config.nearBuildersApiKey) {
    throw new Error("NEARBUILDERS_API_KEY is not set in .env");
  }

  const bot = createBot(config.telegramBotToken);
  await clearCommandMenus(bot);

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    logEvent("info", "bot.shutdown.requested", { signal });
    try {
      bot.stop(signal);
    } catch (error) {
      logEvent("warn", "bot.shutdown.before_polling", {
        err: error,
        signal,
      });
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  await bot.launch({ allowedUpdates: ALL_UPDATE_TYPES }, () => {
    logEvent("info", "bot.polling.started", {
      usernameConfigured: Boolean(bot.botInfo?.username),
    });
  });
}

main().catch((error: unknown) => {
  logEvent("fatal", "bot.startup.failed", { err: error });
  process.exitCode = 1;
});
