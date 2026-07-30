import { fileURLToPath } from "node:url";
import pino from "pino";
import { createStream } from "rotating-file-stream";

const logDirectory = fileURLToPath(new URL("../logs/", import.meta.url));
const logPath = fileURLToPath(new URL("../logs/bot.log", import.meta.url));
const logStream = createStream("bot.log", {
  path: logDirectory,
  size: "5M",
  rotate: 3,
  teeToStdout: true,
});

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  logStream,
);

logger.info({ logPath }, "Logging initialized");
