import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { startHealthServer } from "./health.js";

test("health and readiness endpoints reflect stream state", async () => {
  const state = { connected: false };
  const server = await startHealthServer(0, state);
  const address = server.address() as AddressInfo;
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", connected: false });

    const notReady = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(notReady.status, 503);

    state.connected = true;
    const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
