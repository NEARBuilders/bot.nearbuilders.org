import { fileURLToPath } from "node:url";
import pino from "pino";
import { createStream } from "rotating-file-stream";

export type LogLevel = "info" | "warn" | "error" | "fatal";

export type LogFields = Record<string, unknown>;

const REDACTED_LOG_VALUE = "[REDACTED]";
const REDACTED_LOG_KEYS = new Set([
  "apiKey",
  "api_key",
  "api-key",
  "authorization",
  "body",
  "cookie",
  "deepLink",
  "deepLinkUrl",
  "headers",
  "joinUrl",
  "message",
  "messageBody",
  "messageText",
  "password",
  "payload",
  "profile",
  "profileAnswers",
  "requestBody",
  "responseBody",
  "secret",
  "startUrl",
  "token",
  "url",
  "websiteUrl",
]);
const REDACTED_LOG_PATHS = [
  ...REDACTED_LOG_KEYS,
  ...Array.from(REDACTED_LOG_KEYS, (key) => `*.${key}`),
  "err.message",
  "err.stack",
  "err.cause",
  "err.response",
  "err.on",
];

const logDirectory = fileURLToPath(new URL("../logs/", import.meta.url));
const logPath = fileURLToPath(new URL("../logs/bot.log", import.meta.url));
const logStream = createStream("bot.log", {
  path: logDirectory,
  size: "5M",
  rotate: 3,
  teeToStdout: true,
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: REDACTED_LOG_PATHS,
      censor: REDACTED_LOG_VALUE,
    },
  },
  logStream,
);

export function maskIdentifier(
  value: string | number | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const identifier = String(value);
  if (identifier.length <= 4) return "…";
  return `${identifier.slice(0, 3)}…${identifier.slice(-2)}`;
}

export function sanitizeLogFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      REDACTED_LOG_KEYS.has(key) ? REDACTED_LOG_VALUE : value,
    ]),
  );
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const payload = { ...sanitizeLogFields(fields), event };
  switch (level) {
    case "info":
      logger.info(payload, event);
      return;
    case "warn":
      logger.warn(payload, event);
      return;
    case "error":
      logger.error(payload, event);
      return;
    case "fatal":
      logger.fatal(payload, event);
      return;
  }
}

logEvent("info", "logging.initialized", { logPath });
