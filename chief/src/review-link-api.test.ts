import assert from "node:assert/strict";
import test from "node:test";
import { claimTelegramLink } from "./review-link-api.js";

const INPUT = {
  code: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  telegramId: 456,
  username: "saad",
  name: "Saad",
};

function respond(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    requests.push({ url: url.toString(), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const OPTIONS = {
  apiUrl: "https://nearbuilders.org/api/reviews/telegram-links/claim",
  apiKey: "api_test",
};

test("claims a code for the Telegram sender and returns the linked admin", async () => {
  const { fetcher, requests } = respond(200, { userLabel: "admin.near" });
  const result = await claimTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher });

  assert.deepEqual(result, { userLabel: "admin.near" });
  assert.equal(requests[0]!.url, OPTIONS.apiUrl);
  assert.equal((requests[0]!.init.headers as Record<string, string>)["x-api-key"], "api_test");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), INPUT);
});

test("rejects a malformed response", async () => {
  const { fetcher } = respond(200, { linked: true });
  await assert.rejects(claimTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher }), /malformed/);
});

test("surfaces the website's error message", async () => {
  const { fetcher } = respond(404, {
    message: "This code has expired or was already used. Create a new one in the admin dashboard.",
  });
  await assert.rejects(
    claimTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher }),
    /expired or was already used/,
  );
});
