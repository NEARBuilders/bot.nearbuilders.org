import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const validEnv = {
  X_BEARER_TOKEN: "bearer-token",
  X_CONSUMER_KEY: "consumer-key",
  X_CONSUMER_KEY_SECRET: "consumer-key-secret",
  X_ACCESS_TOKEN: "access-token",
  X_ACCESS_TOKEN_SECRET: "access-token-secret",
  X_BOT_USERNAME: "@NEARBuilders",
  NEARBUILDERS_API_KEY: "nearbuilders-api-key",
};

test("loads read and write X credentials", () => {
  const config = loadConfig(validEnv);

  assert.equal(config.xBearerToken, "bearer-token");
  assert.equal(config.xConsumerKey, "consumer-key");
  assert.equal(config.xConsumerKeySecret, "consumer-key-secret");
  assert.equal(config.xAccessToken, "access-token");
  assert.equal(config.xAccessTokenSecret, "access-token-secret");
  assert.equal(config.xBotUsername, "nearbuilders");
});

test("requires X user credentials used to like nomination posts", () => {
  const { X_ACCESS_TOKEN, ...missingAccessToken } = validEnv;
  assert.throws(
    () => loadConfig(missingAccessToken),
    /X_ACCESS_TOKEN is not set/,
  );
  assert.equal(X_ACCESS_TOKEN, "access-token");
});
