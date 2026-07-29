import "dotenv/config";

const DEFAULT_SKILLS = [
  "Frontend",
  "Backend",
  "Product Owner",
  "Smart Contract",
  "Rust",
  "Typescript",
  "DeFi",
  "AI Automation",
  "DevOps",
  "Data",
];

const configuredSkills = process.env.ALLOWED_SKILLS;

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  nearOnboardingUrl:
    process.env.NEAR_ONBOARDING_URL ??
    "https://nearbuilders.org/api/proposals",
  nearBuildersApiKey: process.env.NEARBUILDERS_API_KEY ?? "",
  nearWalletUrl:
    process.env.NEAR_WALLET_URL ?? "https://wallet.meteorwallet.app",
  botUsername: process.env.BOT_USERNAME?.replace(/^@/, "") ?? "",
  allowedSkills: configuredSkills
    ? configuredSkills
        .split(",")
        .map((skill) => skill.trim())
        .filter(Boolean)
    : DEFAULT_SKILLS,
} as const;

export const ALLOWED_SKILLS = [...config.allowedSkills];
