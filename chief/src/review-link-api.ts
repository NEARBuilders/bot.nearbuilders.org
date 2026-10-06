import { config } from "./config.js";
import { logEvent } from "./logger.js";
import { postReviewApi, type ReviewApiOptions } from "./review-decision-api.js";

export interface TelegramLinkClaim {
  code: string;
  telegramId: number;
  username: string | null;
  name: string | null;
}

export interface TelegramLinkResult {
  userLabel: string;
}

function isLinkResult(value: unknown): value is TelegramLinkResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).userLabel === "string"
  );
}

export async function claimTelegramLink(
  input: TelegramLinkClaim,
  options: ReviewApiOptions = {},
): Promise<TelegramLinkResult> {
  const result = await postReviewApi(
    {
      apiUrl: config.nearTelegramLinkUrl,
      setting: "NEAR_TELEGRAM_LINK_URL",
      event: "telegram_link",
      body: input,
      isValid: isLinkResult,
    },
    options,
  );
  logEvent("info", "telegram_link.claimed");
  return result;
}
