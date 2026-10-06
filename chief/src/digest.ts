import { Telegram } from "telegraf";
import { config } from "./config.js";
import { runDigestJob, type DigestPins } from "./digest-job.js";
import { isDigestText } from "./digest-message.js";
import { pingHeartbeat } from "./heartbeat.js";
import { logEvent } from "./logger.js";
import { fetchReviewDigest } from "./review-digest-api.js";
import { telegramAgent } from "./telegram-agent.js";

function digestPins(telegram: Telegram, chatId: string, botId: number): DigestPins {
  return {
    current: async () => {
      const chat = await telegram.getChat(chatId);
      const pinned = "pinned_message" in chat ? chat.pinned_message : undefined;
      if (!pinned) return null;
      const text = "text" in pinned ? pinned.text : undefined;
      return {
        messageId: pinned.message_id,
        isOwnDigest: pinned.from?.id === botId && isDigestText(text),
      };
    },
    pin: (messageId) =>
      telegram.pinChatMessage(chatId, messageId, { disable_notification: true }),
    remove: (messageId) => telegram.deleteMessage(chatId, messageId),
    edit: (messageId, text) => telegram.editMessageText(chatId, messageId, undefined, text),
  };
}

async function main(): Promise<void> {
  logEvent("info", "digest.begin");
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }
  if (!config.nearBuildersApiKey) {
    throw new Error("NEARBUILDERS_API_KEY is not set in .env");
  }
  if (!config.adminChatId) {
    throw new Error("ADMIN_CHAT_ID is not set in .env");
  }

  const telegram = new Telegram(config.telegramBotToken, {
    agent: telegramAgent,
  });
  const me = await telegram.getMe();
  const outcome = await runDigestJob({
    adminChatId: config.adminChatId,
    siteUrl: config.nearBuildersSiteUrl,
    fetchDigest: () => fetchReviewDigest(),
    sendMessage: (chatId, text, extra) =>
      telegram.sendMessage(chatId, text, extra),
    pins: digestPins(telegram, config.adminChatId, me.id),
  });
  logEvent("info", "digest.finished", { outcome });
  const failed = outcome === "failure_notified";
  await pingHeartbeat(config.digestHeartbeatUrl, failed ? "fail" : "success");
  if (failed) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  logEvent("fatal", "digest.failed", { err: error });
  await pingHeartbeat(config.digestHeartbeatUrl, "fail");
  process.exitCode = 1;
});
