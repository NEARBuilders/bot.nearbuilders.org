import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNomination,
  createNomination,
  NominationApiError,
} from "./nomination-api.js";

const INPUT = {
  source: "telegram",
  sourceNominationId: "42",
  nomineeTelegramId: 123,
  nomineeUsername: "alice",
  nominatedByTelegramId: 456,
  telegramGroupId: -100789,
} as const;

const OPTIONS = {
  apiUrl: "https://nearbuilders.org/api/builders/nominations",
  apiKey: "test-api-key",
} as const;

test("creates a nomination with the Telegram update ID as the idempotency key", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json(
      {
        nominationId: "nom_123",
        status: "awaiting_profile",
        joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
      },
      { status: 201 },
    );
  };

  const result = await createNomination(INPUT, {
    ...OPTIONS,
    fetch: fetchMock,
  });

  assert.equal(requestUrl, OPTIONS.apiUrl);
  assert.equal(requestInit?.method, "POST");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("x-api-key"), "test-api-key");
  assert.equal(headers.get("idempotency-key"), "telegram-nomination:42");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), INPUT);
  assert.deepEqual(result, {
    nominationId: "nom_123",
    status: "awaiting_profile",
    joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
    created: true,
  });
});

test("creates username-only provisional nominations without a website token", async () => {
  const input = {
    ...INPUT,
    nomineeTelegramId: null,
    nomineeUsername: "PendingAlice",
  };
  const fetchMock: typeof fetch = async () =>
    Response.json(
      { nominationId: "nom_pending", status: "awaiting_claim" },
      { status: 201 },
    );

  await assert.doesNotReject(async () => {
    const result = await createNomination(input, {
      ...OPTIONS,
      fetch: fetchMock,
    });
    assert.deepEqual(result, {
      nominationId: "nom_pending",
      status: "awaiting_claim",
      created: true,
    });
  });
});

test("claims through the claim endpoint without an idempotency header", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ nominationId: "nom_123", status: "under_review" });
  };

  const result = await claimNomination(
    {
      nominationId: "nom_123",
      nomineeTelegramId: 123,
      nomineeUsername: "alice",
    },
    { ...OPTIONS, fetch: fetchMock },
  );

  assert.equal(requestUrl, `${OPTIONS.apiUrl}/claim`);
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("idempotency-key"), null);
  assert.deepEqual(result, {
    nominationId: "nom_123",
    status: "under_review",
    created: false,
  });
});

test("retries one network failure and preserves the create idempotency key", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const fetchMock: typeof fetch = async (_input, init) => {
    calls += 1;
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (calls === 1) throw new TypeError("network unavailable");
    return Response.json({
      nominationId: "nom_retry",
      status: "awaiting_claim",
    });
  };

  const result = await createNomination(
    { ...INPUT, nomineeTelegramId: null },
    { ...OPTIONS, fetch: fetchMock },
  );

  assert.equal(calls, 2);
  assert.deepEqual(keys, ["telegram-nomination:42", "telegram-nomination:42"]);
  assert.equal(result.nominationId, "nom_retry");
});

test("retries one timeout", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    if (calls === 1)
      throw new DOMException("request timed out", "TimeoutError");
    return Response.json({
      nominationId: "nom_timeout",
      status: "under_review",
    });
  };

  const result = await claimNomination(
    { nomineeTelegramId: 123, nomineeUsername: "alice" },
    { ...OPTIONS, fetch: fetchMock },
  );

  assert.equal(calls, 2);
  assert.equal(result.status, "under_review");
});

for (const status of [408, 429, 500, 503]) {
  test(`retries HTTP ${status} once`, async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status });
      return Response.json({
        nominationId: `nom_${status}`,
        status: "accepted",
      });
    };

    const result = await createNomination(INPUT, {
      ...OPTIONS,
      fetch: fetchMock,
    });

    assert.equal(calls, 2);
    assert.equal(result.status, "accepted");
  });
}

for (const status of [400, 401, 403, 404, 409, 422]) {
  test(`does not retry permanent HTTP ${status}`, async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return new Response("permanent", { status });
    };

    await assert.rejects(
      createNomination(INPUT, { ...OPTIONS, fetch: fetchMock }),
      (error: unknown) =>
        error instanceof NominationApiError && error.status === status,
    );
    assert.equal(calls, 1);
  });
}

test("does not retry malformed successful responses", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return Response.json({ nominationId: "nom_bad" });
  };

  await assert.rejects(
    createNomination(INPUT, { ...OPTIONS, fetch: fetchMock }),
    /malformed response/,
  );
  assert.equal(calls, 1);
});

test("rejects join URLs outside the awaiting-profile state", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({
      nominationId: "nom_leaky",
      status: "rejected",
      joinUrl: "https://nearbuilders.org/join?nomination=should-not-leak",
    });

  await assert.rejects(
    createNomination(INPUT, { ...OPTIONS, fetch: fetchMock }),
    /malformed response/,
  );
});

for (const hostname of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) {
  test(`accepts HTTP development URLs on ${hostname}`, async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({
        nominationId: "nom_local",
        status: "awaiting_profile",
        joinUrl: `http://${hostname}:3000/join?nomination=opaque-token`,
      });

    const result = await createNomination(INPUT, {
      apiUrl: `http://${hostname}:3000/api/builders/nominations`,
      apiKey: "test-api-key",
      fetch: fetchMock,
    });

    assert.equal(result.status, "awaiting_profile");
    assert.equal(
      result.joinUrl,
      `http://${hostname}:3000/join?nomination=opaque-token`,
    );
  });
}

test("rejects HTTP production endpoints before making a request", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return Response.json({ nominationId: "nom_123", status: "accepted" });
  };

  await assert.rejects(
    createNomination(INPUT, {
      apiUrl: "http://nearbuilders.org/api/builders/nominations",
      apiKey: "test-api-key",
      fetch: fetchMock,
    }),
    /must use HTTPS/,
  );
  assert.equal(calls, 0);
});
