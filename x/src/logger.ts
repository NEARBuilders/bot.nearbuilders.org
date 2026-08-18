import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pino from "pino";
import { createStream } from "rotating-file-stream";

const logDirectory = fileURLToPath(new URL("../logs/", import.meta.url));
const logPath = fileURLToPath(new URL("../logs/bot.log", import.meta.url));
mkdirSync(logDirectory, { recursive: true });

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
      paths: [
        "apiKey",
        "apiSecret",
        "consumerKey",
        "consumerKeySecret",
        "accessToken",
        "accessTokenSecret",
        "bearerToken",
        "xBearerToken",
        "xConsumerKey",
        "xConsumerKeySecret",
        "xAccessToken",
        "xAccessTokenSecret",
        "nearBuildersApiKey",
        "*.apiKey",
        "*.apiSecret",
        "*.consumerKey",
        "*.consumerKeySecret",
        "*.accessToken",
        "*.accessTokenSecret",
        "*.bearerToken",
        "*.xBearerToken",
        "*.xConsumerKey",
        "*.xConsumerKeySecret",
        "*.xAccessToken",
        "*.xAccessTokenSecret",
        "*.nearBuildersApiKey",
        "headers.authorization",
        "*.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
  },
  logStream,
);

logger.info({ logPath }, "Logging initialized");
