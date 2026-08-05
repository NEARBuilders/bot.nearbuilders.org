import "dotenv/config";

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  nearNominationUrl:
    process.env.NEAR_NOMINATION_URL ??
    "https://nearbuilders.org/api/builders/nominations",
  nearBuildersApiKey: process.env.NEARBUILDERS_API_KEY ?? "",
  botUsername: process.env.BOT_USERNAME?.replace(/^@/, "") ?? "",
} as const;
