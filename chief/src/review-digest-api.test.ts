import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchReviewDigest,
  parseReviewDigest,
  ReviewDigestApiError,
} from "./review-digest-api.js";

const DIGEST = {
  generatedAt: "2026-09-26T09:00:00.000Z",
  staleAfterDays: 7,
  totals: { pending: 1, newLast24h: 1, stale: 0, needsAttention: 0 },
  byPlugin: { builders: 1, projects: 0, events: 0, nearcatalog: 0 },
  items: [
    {
      id: "proposal-1",
      pluginId: "builders",
      entityId: "alice.near",
      title: "Alice",
      state: "pending",
      createdAt: "2026-09-26T08:00:00.000Z",
      ageDays: 0,
      isNew: true,
      isStale: false,
      dashboardPath: "/admin/dashboard/builders?item=alice.near&status=pending",
    },
  ],
};

const OPTIONS = {
  apiUrl: "https://nearbuilders.org/api/reviews/digest",
  apiKey: "test-api-key",
  staleAfterDays: 7,
  retryDelaysMs: [1, 1],
  sleep: async () => undefined,
} as const;

test("requests the digest with the API key and stale threshold", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json(DIGEST);
  };

  const digest = await fetchReviewDigest({ ...OPTIONS, fetch: fetchMock });

  assert.equal(
    requestUrl,
    "https://nearbuilders.org/api/reviews/digest?staleAfterDays=7",
  );
  assert.equal(requestInit?.method, "GET");
  assert.deepEqual(requestInit?.headers, {
    accept: "application/json",
    "x-api-key": "test-api-key",
  });
  assert.equal(digest.totals.pending, 1);
  assert.equal(digest.items[0]?.title, "Alice");
});

test("retries transient failures and then succeeds", async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    if (calls === 2) return new Response("busy", { status: 503 });
    return Response.json(DIGEST);
  };

  const digest = await fetchReviewDigest({
    ...OPTIONS,
    retryDelaysMs: [10, 20],
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: fetchMock,
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(digest.totals.pending, 1);
});

test("gives up after the retry schedule is exhausted", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response("busy", { status: 502 });
  };

  await assert.rejects(
    fetchReviewDigest({ ...OPTIONS, fetch: fetchMock }),
    (error: unknown) =>
      error instanceof ReviewDigestApiError && error.status === 502,
  );
  assert.equal(calls, 3);
});

test("does not retry authorization failures", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  };

  await assert.rejects(
    fetchReviewDigest({ ...OPTIONS, fetch: fetchMock }),
    (error: unknown) =>
      error instanceof ReviewDigestApiError && error.status === 403,
  );
  assert.equal(calls, 1);
});

test("rejects insecure endpoints before sending the API key", async () => {
  let called = false;
  const fetchMock: typeof fetch = async () => {
    called = true;
    return Response.json(DIGEST);
  };

  await assert.rejects(
    fetchReviewDigest({
      ...OPTIONS,
      apiUrl: "http://nearbuilders.org/api/reviews/digest",
      fetch: fetchMock,
    }),
    /must use HTTPS/,
  );
  assert.equal(called, false);
});

test("parses digests from older and newer API versions", () => {
  const legacy = parseReviewDigest(DIGEST);
  assert.equal(legacy.activity, null);
  assert.equal(legacy.totals.oldestPendingDays, null);
  assert.equal(legacy.items[0]?.submittedBy, null);

  const current = parseReviewDigest({
    ...DIGEST,
    totals: { ...DIGEST.totals, oldestPendingDays: 3 },
    activity: {
      last24h: { approved: 2, rejected: 0 },
      last7d: { reviewed: 5, medianWaitDays: 1.5 },
      previous7d: { reviewed: 0, medianWaitDays: null },
    },
    items: [
      {
        ...DIGEST.items[0],
        submittedBy: "bob.near",
        detail: "Rust",
        evaluation: { verdict: "ready", score: 90, summary: "Solid.", flags: [] },
      },
    ],
  });
  assert.equal(current.totals.oldestPendingDays, 3);
  assert.equal(current.activity?.last7d.medianWaitDays, 1.5);
  assert.equal(current.items[0]?.detail, "Rust");
  assert.equal(current.items[0]?.evaluation?.verdict, "ready");
  assert.equal(legacy.items[0]?.evaluation, null);
  assert.throws(
    () =>
      parseReviewDigest({
        ...DIGEST,
        items: [{ ...DIGEST.items[0], evaluation: { verdict: "approve" } }],
      }),
    /malformed/,
  );
  assert.throws(
    () => parseReviewDigest({ ...DIGEST, activity: { last24h: {} } }),
    /malformed/,
  );
});

test("rejects malformed digests and off-dashboard links", () => {
  assert.throws(() => parseReviewDigest({}), /malformed/);
  assert.throws(
    () =>
      parseReviewDigest({
        ...DIGEST,
        items: [{ ...DIGEST.items[0], dashboardPath: "https://evil.example" }],
      }),
    /malformed/,
  );
  assert.throws(
    () =>
      parseReviewDigest({
        ...DIGEST,
        totals: { ...DIGEST.totals, pending: -1 },
      }),
    /malformed/,
  );
});
