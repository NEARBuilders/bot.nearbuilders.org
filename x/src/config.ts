import "dotenv/config";

export interface Config {
  xBearerToken: string;
  xBotUsername: string;
  nearBuildersNominationUrl: string;
  nearBuildersApiKey: string;
  port: number;
  logLevel: string;
  streamRuleTag: string;
}

function requiredString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is not set`);
  return trimmed;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const xBotUsername = requiredString(env.X_BOT_USERNAME, "X_BOT_USERNAME")
    .replace(/^@/, "")
    .toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(xBotUsername)) {
    throw new Error("X_BOT_USERNAME must be a valid X username");
  }

  const nominationUrl = env.NEARBUILDERS_NOMINATION_URL ??
    "https://nearbuilders.org/api/builders/nominations/x";
  const parsedNominationUrl = new URL(nominationUrl);
  if (parsedNominationUrl.protocol !== "https:" &&
      !new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]).has(parsedNominationUrl.hostname)) {
    throw new Error("NEARBUILDERS_NOMINATION_URL must use HTTPS outside loopback");
  }

  return {
    xBearerToken: requiredString(env.X_BEARER_TOKEN, "X_BEARER_TOKEN"),
    xBotUsername,
    nearBuildersNominationUrl: parsedNominationUrl.toString(),
    nearBuildersApiKey: requiredString(env.NEARBUILDERS_API_KEY, "NEARBUILDERS_API_KEY"),
    port: parsePort(env.PORT),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    streamRuleTag: env.X_STREAM_RULE_TAG?.trim() || "nearbuilders-x-bot",
  };
}
