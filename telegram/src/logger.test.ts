import assert from "node:assert/strict";
import test from "node:test";
import { maskIdentifier, sanitizeLogFields } from "./logger.js";

test("masks identifiers before they are written to logs", () => {
  assert.equal(maskIdentifier("nomination-123"), "nom…23");
  assert.equal(maskIdentifier("abc"), "…");
  assert.equal(maskIdentifier(undefined), undefined);
});

test("redacts sensitive log fields", () => {
  assert.deepEqual(
    sanitizeLogFields({
      apiKey: "secret",
      authorization: "Bearer secret",
      body: { profile: "private answer" },
      deepLinkUrl: "https://t.me/testbot?start=secret",
      joinUrl: "https://nearbuilders.org/join?token=secret",
      messageText: "private profile answer",
      payload: { name: "Alice" },
      requestBody: { token: "secret" },
      token: "secret",
      url: "https://nearbuilders.org/join?token=secret",
      endpointPath: "/api/builders/nominations",
      status: "awaiting_profile",
    }),
    {
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      body: "[REDACTED]",
      deepLinkUrl: "[REDACTED]",
      joinUrl: "[REDACTED]",
      messageText: "[REDACTED]",
      payload: "[REDACTED]",
      requestBody: "[REDACTED]",
      token: "[REDACTED]",
      url: "[REDACTED]",
      endpointPath: "/api/builders/nominations",
      status: "awaiting_profile",
    },
  );
});
