import { config } from "./config.js";
import { logEvent } from "./logger.js";
import {
  postReviewApi,
  ReviewDecisionError,
  type ReviewApiOptions,
} from "./review-decision-api.js";

export interface TelegramLinkInput {
  telegramId: number;
  username: string | null;
  name: string | null;
}

export interface TelegramLinkResult {
  url: string;
  expiresAt: string;
  linkedAs: string | null;
}

interface LinkResponse {
  path: string;
  expiresAt: string;
  linkedAs: string | null;
}

function isLinkResponse(value: unknown): value is LinkResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === "string" &&
    record.path.startsWith("/") &&
    typeof record.expiresAt === "string" &&
    (record.linkedAs === null || typeof record.linkedAs === "string")
  );
}

export async function requestTelegramLink(
  input: TelegramLinkInput,
  options: ReviewApiOptions & { siteUrl?: string } = {},
): Promise<TelegramLinkResult> {
  const response = await postReviewApi(
    {
      apiUrl: config.nearTelegramLinkUrl,
      setting: "NEAR_TELEGRAM_LINK_URL",
      event: "telegram_link",
      body: input,
      isValid: isLinkResponse,
    },
    options,
  );
  const site = new URL(options.siteUrl ?? config.nearBuildersSiteUrl);
  const url = new URL(response.path, site);
  if (url.origin !== site.origin) {
    throw new ReviewDecisionError("The website returned a malformed response");
  }
  logEvent("info", "telegram_link.created", { alreadyLinked: Boolean(response.linkedAs) });
  return {
    url: url.toString(),
    expiresAt: response.expiresAt,
    linkedAs: response.linkedAs,
  };
}
