import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStreamRule,
  ensureStreamRule,
  runFilteredStream,
} from "./stream.js";
import { XApiError, type XApi, type XRule, type XStream } from "./x-api.js";

test("builds the filtered-stream rule", () => {
  assert.equal(
    buildStreamRule("nearbuilders"),
    "@nearbuilders onboard -is:retweet",
  );
});

test("reconciles only rules owned by this bot", async () => {
  const rules: XRule[] = [
    { id: "keep", value: "#near", tag: "other-app" },
    { id: "stale", value: "@nearbuilders !onboard", tag: "nearbuilders-x-bot" },
    { id: "duplicate", value: "@nearbuilders onboard -is:retweet", tag: "nearbuilders-x-bot" },
  ];
  const deleted: string[][] = [];
  const added: Array<{ value: string; tag: string }> = [];

  await ensureStreamRule(
    {
      getStreamRules: async () => rules,
      deleteStreamRules: async (ids) => {
        deleted.push(ids);
      },
      addStreamRule: async (value, tag) => {
        added.push({ value, tag });
      },
    },
    "@nearbuilders onboard -is:retweet",
    "nearbuilders-x-bot",
  );

  assert.deepEqual(deleted, [["stale"]]);
  assert.deepEqual(added, []);
  assert.deepEqual(rules[0], { id: "keep", value: "#near", tag: "other-app" });
});

test("adds the rule when no owned rule exists", async () => {
  const added: Array<{ value: string; tag: string }> = [];
  await ensureStreamRule(
    {
      getStreamRules: async () => [],
      deleteStreamRules: async () => undefined,
      addStreamRule: async (value, tag) => {
        added.push({ value, tag });
      },
    },
    "@nearbuilders onboard -is:retweet",
    "nearbuilders-x-bot",
  );
  assert.deepEqual(added, [
    { value: "@nearbuilders onboard -is:retweet", tag: "nearbuilders-x-bot" },
  ]);
});

function closedStream(onClose: () => void): XStream {
  return {
    async *[Symbol.asyncIterator]() {
      // The stream closes without delivering an event.
    },
    close: onClose,
  };
}

function streamClient(
  streamPosts: XApi["streamPosts"],
  getStreamRules: XApi["getStreamRules"] = async () => [],
): XApi {
  return {
    getUserByUsername: async () => null,
    getPostAuthor: async () => null,
    likePost: async () => undefined,
    getStreamRules,
    addStreamRule: async () => undefined,
    deleteStreamRules: async () => undefined,
    streamPosts,
  };
}

test("reconnects after a clean stream close and stops when aborted", async () => {
  const controller = new AbortController();
  let connections = 0;
  let closes = 0;
  const delays: number[] = [];
  const states: boolean[] = [];

  await runFilteredStream({
    client: streamClient(async () => {
      connections += 1;
      return closedStream(() => {
        closes += 1;
      });
    }),
    botUsername: "nearbuilders",
    ruleTag: "nearbuilders-x-bot",
    signal: controller.signal,
    onEvent: async () => undefined,
    onStateChange: (state) => states.push(state.connected),
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
      controller.abort();
    },
  });

  assert.equal(connections, 1);
  assert.equal(closes, 1);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(states, [true, false, false]);
});

test("fails fast on X authentication errors", async () => {
  const controller = new AbortController();
  let sleeps = 0;

  await assert.rejects(
    runFilteredStream({
      client: streamClient(async () => {
        throw new XApiError("unauthorized", 401);
      }),
      botUsername: "nearbuilders",
      ruleTag: "nearbuilders-x-bot",
      signal: controller.signal,
      onEvent: async () => undefined,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    (error: unknown) => error instanceof XApiError && error.status === 401,
  );
  assert.equal(sleeps, 0);
});
