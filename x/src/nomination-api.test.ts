import assert from "node:assert/strict";
import test from "node:test";
import {
  createNomination,
  NominationApiError,
  type CreateXNominationRequest,
} from "./nomination-api.js";

const INPUT: CreateXNominationRequest = {
  source: "x",
  sourceNominationId: "123456789",
  sourcePostUrl: "https://x.com/i/web/status/123456789",
  sourcePostText: "@NEARBuilders !onboard @alice",
  sourcePostCreatedAt: "2026-08-04T13:00:00.000Z",
  nominatedByXId: "987654321",
  nominatedByXUsername: "bob",
  nomineeXId: "456789123",
  nomineeXUsername: "alice",
  conversationId: "123456789",
  replyToPostId: null,
};

const OPTIONS = {
  apiUrl: "https://nearbuilders.org/api/builders/nominations/x",
  apiKey: "test-api-key",
} as const;

test("creates an X nomination with a stable idempotency key", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json(
      {
        nominationId: "nom_123",
        source: "x",
        engagementStatus: "pending_contact",
        onboardingStatus: "awaiting_profile",
        joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
        proposalId: null,
        proposalEntityId: null,
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
  assert.equal(headers.get("idempotency-key"), "x-nomination:123456789");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), INPUT);
  assert.deepEqual(result, {
    nominationId: "nom_123",
    source: "x",
    engagementStatus: "pending_contact",
    onboardingStatus: "awaiting_profile",
    joinUrl: "https://nearbuilders.org/join?nomination=opaque-token",
    proposalId: null,
    proposalEntityId: null,
    created: true,
  });
});

test("retries one network failure without changing idempotency", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const fetchMock: typeof fetch = async (_input, init) => {
    calls += 1;
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (calls === 1) throw new TypeError("network unavailable");
    return Response.json({
      nominationId: "nom_retry",
      source: "x",
      engagementStatus: "pending_contact",
      onboardingStatus: "awaiting_profile",
      proposalId: null,
      proposalEntityId: null,
    });
  };

  const result = await createNomination(INPUT, {
    ...OPTIONS,
    fetch: fetchMock,
  });

  assert.equal(result.nominationId, "nom_retry");
  assert.deepEqual(keys, ["x-nomination:123456789", "x-nomination:123456789"]);
});

test("does not retry an unapproved nominator response", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response("unapproved", { status: 403 });
  };

  await assert.rejects(
    createNomination(INPUT, { ...OPTIONS, fetch: fetchMock }),
    (error: unknown) => error instanceof NominationApiError && error.status === 403,
  );
  assert.equal(calls, 1);
});

test("rejects insecure join URLs", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({
      nominationId: "nom_bad",
      source: "x",
      engagementStatus: "pending_contact",
      onboardingStatus: "awaiting_profile",
      joinUrl: "http://attacker.example/join?nomination=leak",
      proposalId: null,
      proposalEntityId: null,
    });

  await assert.rejects(
    createNomination(INPUT, { ...OPTIONS, fetch: fetchMock }),
    /joinUrl must use HTTPS/,
  );
});
