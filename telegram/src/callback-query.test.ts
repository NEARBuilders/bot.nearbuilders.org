import assert from "node:assert/strict";
import test from "node:test";
import { TelegramError } from "telegraf";
import {
  acknowledgeCallbackQuery,
  isExpiredCallbackQueryError,
} from "./callback-query.js";

const EXPIRED_CALLBACK_ERROR = new TelegramError({
  error_code: 400,
  description:
    "Bad Request: query is too old and response timeout expired or query ID is invalid",
});

test("recognizes Telegram's expired callback query response", () => {
  assert.equal(isExpiredCallbackQueryError(EXPIRED_CALLBACK_ERROR), true);
  assert.equal(
    isExpiredCallbackQueryError(
      new TelegramError({
        error_code: 400,
        description: "Bad Request: another callback error",
      }),
    ),
    false,
  );
});

test("stops processing an expired callback query", async () => {
  const acknowledged = await acknowledgeCallbackQuery(async () => {
    throw EXPIRED_CALLBACK_ERROR;
  });

  assert.equal(acknowledged, false);
});

test("rethrows unexpected callback query failures", async () => {
  const error = new Error("network unavailable");

  await assert.rejects(
    acknowledgeCallbackQuery(async () => {
      throw error;
    }),
    error,
  );
});
