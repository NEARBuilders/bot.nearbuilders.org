import assert from "node:assert/strict";
import test from "node:test";
import { createNomination } from "./nomination-api.js";

const INPUT = {
  source: "telegram",
  sourceNominationId: "42",
  nomineeTelegramId: 123,
  nomineeUsername: "alice",
  nominatedByTelegramId: 456,
  telegramGroupId: -100789,
} as const;

test("creates a website nomination and returns its handoff", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({
        nominationId: "nom_123",
        joinUrl: "https://join.nearbuilders.org/?nomination=opaque-token",
      }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const result = await createNomination(INPUT, {
    apiUrl: "https://nearbuilders.org/api/builders/nominations",
    apiKey: "test-api-key",
    fetch: fetchMock,
  });

  assert.equal(requestUrl, "https://nearbuilders.org/api/builders/nominations");
  assert.equal(requestInit?.method, "POST");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("x-api-key"), "test-api-key");
  assert.equal(headers.get("idempotency-key"), "telegram-nomination:42");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), INPUT);
  assert.deepEqual(result, {
    nominationId: "nom_123",
    joinUrl: "https://join.nearbuilders.org/?nomination=opaque-token",
  });
});

test("accepts an idempotent nomination retry response", async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("idempotency-key"), "telegram-nomination:42");
    return Response.json({
      nominationId: "nom_123",
      joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
    });
  };

  const result = await createNomination(INPUT, {
    apiUrl: "https://nearbuilders.org/api/builders/nominations",
    apiKey: "test-api-key",
    fetch: fetchMock,
  });

  assert.deepEqual(result, {
    nominationId: "nom_123",
    joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
  });
});

for (const hostname of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) {
  test(`accepts HTTP development URLs on ${hostname}`, async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({
        nominationId: "nom_local",
        joinUrl: `http://${hostname}:3000/join?nomination=opaque-token`,
      });

    const result = await createNomination(INPUT, {
      apiUrl: `http://${hostname}:3000/api/builders/nominations`,
      apiKey: "test-api-key",
      fetch: fetchMock,
    });

    assert.equal(
      result.joinUrl,
      `http://${hostname}:3000/join?nomination=opaque-token`,
    );
  });
}

test("rejects HTTP URLs on non-loopback hosts", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({
      nominationId: "nom_123",
      joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
    });

  await assert.rejects(
    createNomination(INPUT, {
      apiUrl: "http://nearbuilders.org/api/builders/nominations",
      apiKey: "test-api-key",
      fetch: fetchMock,
    }),
    /must use HTTPS/,
  );
});

test("rejects a failed nomination API response", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response("Unauthorized", { status: 401 });

  await assert.rejects(
    createNomination(INPUT, {
      apiUrl: "https://nearbuilders.org/api/builders/nominations",
      apiKey: "test-api-key",
      fetch: fetchMock,
    }),
    /HTTP 401/,
  );
});

test("rejects an invalid handoff response", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({ nominationId: "nom_123" });

  await assert.rejects(
    createNomination(INPUT, {
      apiUrl: "https://nearbuilders.org/api/builders/nominations",
      apiKey: "test-api-key",
      fetch: fetchMock,
    }),
    /invalid handoff response/,
  );
});
