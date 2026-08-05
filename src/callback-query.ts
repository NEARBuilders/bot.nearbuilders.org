import { TelegramError } from "telegraf";
import { logger } from "./logger.js";

const EXPIRED_CALLBACK_QUERY_DESCRIPTION =
  "Bad Request: query is too old and response timeout expired or query ID is invalid";

export function isExpiredCallbackQueryError(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    error.description === EXPIRED_CALLBACK_QUERY_DESCRIPTION
  );
}

export async function acknowledgeCallbackQuery(
  answer: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await answer();
    return true;
  } catch (error) {
    if (!isExpiredCallbackQueryError(error)) throw error;

    logger.info("Ignored expired Telegram callback query");
    return false;
  }
}
