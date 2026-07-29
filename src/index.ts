import type { Types } from "telegraf";
import { clearCommandMenus, createBot } from "./bot.js";
import { config } from "./config.js";
import * as db from "./db.js";
import { logger } from "./logger.js";

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
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }

  await db.setupDb();
  logger.info("Database tables ready");

  const bot = createBot(config.telegramBotToken);
  await clearCommandMenus(bot);

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    try {
      bot.stop(signal);
    } catch (error) {
      logger.warn(
        { err: error, signal },
        "Bot stopped before polling initialized",
      );
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    await bot.launch(
      { allowedUpdates: ALL_UPDATE_TYPES },
      () => {
        logger.info(
          { username: bot.botInfo?.username },
          "Bot is running with long polling",
        );
      },
    );
  } finally {
    await db.closeDb();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "Bot failed to start");
  process.exitCode = 1;
});
