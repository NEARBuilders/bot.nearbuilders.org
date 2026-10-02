import "dotenv/config";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveUrl(path: string, base: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    return "";
  }
}

const nearBuildersSiteUrl =
  process.env.NEARBUILDERS_SITE_URL?.trim() || "https://nearbuilders.org";

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  nearBuildersApiKey: process.env.NEARBUILDERS_API_KEY ?? "",
  adminChatId: process.env.ADMIN_CHAT_ID?.trim() ?? "",
  nearBuildersSiteUrl,
  nearReviewDigestUrl:
    process.env.NEAR_REVIEW_DIGEST_URL ?? resolveUrl("/api/reviews/digest", nearBuildersSiteUrl),
  nearReviewDecisionUrl:
    process.env.NEAR_REVIEW_DECISION_URL ??
    resolveUrl("/api/reviews/telegram-decision", nearBuildersSiteUrl),
  nearTelegramLinkUrl:
    process.env.NEAR_TELEGRAM_LINK_URL ??
    resolveUrl("/api/reviews/telegram-links/claim", nearBuildersSiteUrl),
  digestStaleAfterDays: positiveInteger(process.env.DIGEST_STALE_AFTER_DAYS, 7),
  digestHeartbeatUrl: process.env.DIGEST_HEARTBEAT_URL?.trim() ?? "",
} as const;
