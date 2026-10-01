import assert from "node:assert/strict";
import test from "node:test";
import { requestTelegramLink } from "./review-link-api.js";

const INPUT = { telegramId: 456, username: "saad", name: "Saad" };

function respond(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    requests.push({ url: url.toString(), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const OPTIONS = {
  apiUrl: "https://nearbuilders.org/api/reviews/telegram-links",
  apiKey: "api_test",
  siteUrl: "https://nearbuilders.org",
};

test("posts the Telegram identity and returns an absolute link", async () => {
  const { fetcher, requests } = respond(200, {
    path: "/admin/telegram-link?code=abc",
    expiresAt: "2026-09-30T08:10:00.000Z",
    linkedAs: null,
  });
  const result = await requestTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher });

  assert.deepEqual(result, {
    url: "https://nearbuilders.org/admin/telegram-link?code=abc",
    expiresAt: "2026-09-30T08:10:00.000Z",
    linkedAs: null,
  });
  assert.equal(requests[0]!.url, OPTIONS.apiUrl);
  assert.equal((requests[0]!.init.headers as Record<string, string>)["x-api-key"], "api_test");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), INPUT);
});

test("rejects a link that would leave the site", async () => {
  for (const path of ["https://evil.example/phish", "//evil.example/phish"]) {
    const { fetcher } = respond(200, {
      path,
      expiresAt: "2026-09-30T08:10:00.000Z",
      linkedAs: null,
    });
    await assert.rejects(requestTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher }), /malformed/);
  }
});

test("surfaces the website's error message", async () => {
  const { fetcher } = respond(403, { message: "Missing permission reviews:write" });
  await assert.rejects(
    requestTelegramLink(INPUT, { ...OPTIONS, fetch: fetcher }),
    /Missing permission reviews:write/,
  );
});
