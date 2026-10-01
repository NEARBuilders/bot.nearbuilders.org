import { TelegramError, type Telegram } from "telegraf";
import {
  formatAllClearMessage,
  formatDigestFailureMessage,
  formatDigestMessage,
} from "./digest-message.js";
import { logEvent, maskIdentifier } from "./logger.js";
import { digestKeyboard } from "./review-actions.js";
import type { ReviewDigest } from "./review-digest-api.js";

type SendMessageExtra = NonNullable<Parameters<Telegram["sendMessage"]>[2]>;

export type DigestOutcome =
  | "sent"
  | "all_clear_sent"
  | "skipped_empty"
  | "failure_notified";

const ALL_CLEAR_WEEKDAY_UTC = 1;

export interface PinnedMessage {
  messageId: number;
  isOwnDigest: boolean;
}

export interface DigestPins {
  current: () => Promise<PinnedMessage | null>;
  pin: (messageId: number) => Promise<unknown>;
  remove: (messageId: number) => Promise<unknown>;
}

export interface DigestJobDependencies {
  adminChatId: string;
  siteUrl: string;
  now?: () => Date;
  fetchDigest: () => Promise<ReviewDigest>;
  sendMessage: (
    chatId: string,
    text: string,
    extra: SendMessageExtra,
  ) => Promise<unknown>;
  pins?: DigestPins;
}

function sentMessageId(result: unknown): number | null {
  if (typeof result !== "object" || result === null) return null;
  const id = (result as { message_id?: unknown }).message_id;
  return typeof id === "number" ? id : null;
}

async function replacePinnedDigest(
  pins: DigestPins | undefined,
  sent: unknown,
  chat: string | undefined,
): Promise<void> {
  const messageId = sentMessageId(sent);
  if (!pins || messageId === null) return;
  try {
    const previous = await pins.current();
    await pins.pin(messageId);
    if (previous?.isOwnDigest && previous.messageId !== messageId) {
      await pins.remove(previous.messageId);
    }
    logEvent("info", "digest.pinned", {
      chat,
      replacedPrevious: Boolean(previous?.isOwnDigest),
    });
  } catch (error) {
    logEvent("warn", "digest.pin_failed", {
      err: error,
      chat,
      ...telegramErrorFields(error),
    });
  }
}

function telegramErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof TelegramError)) return {};
  return {
    telegramErrorCode: error.response.error_code,
    telegramDescription: error.response.description,
    ...(error.response.parameters?.migrate_to_chat_id
      ? { migrateToChatId: error.response.parameters.migrate_to_chat_id }
      : {}),
  };
}

async function notifyFailure(
  dependencies: DigestJobDependencies,
  chat: string | undefined,
): Promise<DigestOutcome> {
  const dashboardUrl = new URL(
    "/admin/dashboard",
    dependencies.siteUrl,
  ).toString();
  await dependencies.sendMessage(
    dependencies.adminChatId,
    `${formatDigestFailureMessage()}\n${dashboardUrl}`,
    {
      disable_notification: true,
      link_preview_options: { is_disabled: true },
    },
  );
  logEvent("warn", "digest.failure_notified", { chat });
  return "failure_notified";
}

export async function runDigestJob(
  dependencies: DigestJobDependencies,
): Promise<DigestOutcome> {
  const chat = maskIdentifier(dependencies.adminChatId);
  let digest: ReviewDigest;
  try {
    digest = await dependencies.fetchDigest();
  } catch (error) {
    logEvent("error", "digest.fetch_failed", { err: error, chat });
    return await notifyFailure(dependencies, chat);
  }

  const now = dependencies.now?.() ?? new Date();
  const message = formatDigestMessage(digest, { siteUrl: dependencies.siteUrl });
  if (!message) {
    if (now.getUTCDay() !== ALL_CLEAR_WEEKDAY_UTC) {
      logEvent("info", "digest.skipped.empty", { chat });
      return "skipped_empty";
    }
    const sent = await dependencies.sendMessage(
      dependencies.adminChatId,
      formatAllClearMessage(),
      { disable_notification: true },
    );
    logEvent("info", "digest.all_clear_sent", { chat });
    await replacePinnedDigest(dependencies.pins, sent, chat);
    return "all_clear_sent";
  }

  let sent: unknown;
  try {
    sent = await dependencies.sendMessage(dependencies.adminChatId, message.text, {
      parse_mode: "HTML",
      disable_notification: message.disableNotification,
      link_preview_options: { is_disabled: true },
      ...digestKeyboard(message),
    });
  } catch (error) {
    logEvent("error", "digest.send_failed", {
      err: error,
      chat,
      ...telegramErrorFields(error),
    });
    return await notifyFailure(dependencies, chat);
  }
  logEvent("info", "digest.sent", {
    chat,
    pending: digest.totals.pending,
    newLast24h: digest.totals.newLast24h,
    stale: digest.totals.stale,
    needsAttention: digest.totals.needsAttention,
    silent: message.disableNotification,
    length: message.text.length,
  });
  await replacePinnedDigest(dependencies.pins, sent, chat);
  return "sent";
}
