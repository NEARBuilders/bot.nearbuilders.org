import assert from "node:assert/strict";
import test from "node:test";
import { heartbeatUrl, pingHeartbeat } from "./heartbeat.js";

const BASE = "https://hc-ping.com/0f3c9a52-1111-2222-3333-444455556666";

test("builds success and failure ping URLs", () => {
  assert.equal(heartbeatUrl(BASE, "success").toString(), BASE);
  assert.equal(heartbeatUrl(`${BASE}/`, "fail").toString(), `${BASE}/fail`);
  assert.throws(() => heartbeatUrl("http://hc-ping.com/x", "success"), /HTTPS/);
});

test("pings the heartbeat URL", async () => {
  const requests: string[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    requests.push(`${init?.method} ${String(input)}`);
    return new Response("OK");
  };
  assert.equal(await pingHeartbeat(BASE, "fail", { fetch: fetchMock }), true);
  assert.deepEqual(requests, [`POST ${BASE}/fail`]);
});

test("skips when no heartbeat URL is configured", async () => {
  let called = false;
  const fetchMock: typeof fetch = async () => {
    called = true;
    return new Response("OK");
  };
  assert.equal(await pingHeartbeat("", "success", { fetch: fetchMock }), false);
  assert.equal(called, false);
});

test("never throws when the heartbeat service is down", async () => {
  const fetchMock: typeof fetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await pingHeartbeat(BASE, "success", { fetch: fetchMock }), false);
  assert.equal(
    await pingHeartbeat("not a url", "success", { fetch: fetchMock }),
    false,
  );
});
