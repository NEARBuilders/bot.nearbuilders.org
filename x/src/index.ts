import { createXApi } from "./x-api.js";
import { handlePostEvent, productionNominationDependencies } from "./handler.js";
import { loadConfig } from "./config.js";
import { startHealthServer, type HealthState } from "./health.js";
import { logger } from "./logger.js";
import { runFilteredStream } from "./stream.js";

async function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const x = createXApi(config.xBearerToken);
  const state: HealthState = { connected: false };
  const healthServer = await startHealthServer(config.port, state);
  const controller = new AbortController();

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    logger.info({ signal }, "Stopping X bot");
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      botUsername: config.xBotUsername,
      nominationEndpoint: config.nearBuildersNominationUrl,
    },
    "Starting stateless NEAR Builders X bot",
  );

  await runFilteredStream({
    client: x,
    botUsername: config.xBotUsername,
    ruleTag: config.streamRuleTag,
    signal: controller.signal,
    onStateChange: (nextState) => {
      state.connected = nextState.connected;
      logger.info(nextState, nextState.connected ? "Connected to X filtered stream" : "Disconnected from X filtered stream");
    },
    onEvent: async (event) => {
      await handlePostEvent(event, {
        botUsername: config.xBotUsername,
        x,
        nominations: {
          createNomination: (input) => productionNominationDependencies.createNomination(input, {
            apiUrl: config.nearBuildersNominationUrl,
            apiKey: config.nearBuildersApiKey,
          }),
        },
      });
    },
  });

  await closeServer(healthServer);
  logger.info("X bot stopped");
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "X bot failed to start");
  process.exitCode = 1;
});
