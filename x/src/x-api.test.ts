import assert from "node:assert/strict";
import test from "node:test";
import {
  createXApi,
  type XdkClientLike,
  type XStream,
} from "./x-api.js";

function emptyStream(): XStream {
  return {
    async *[Symbol.asyncIterator]() {
      // No events.
    },
    close() {
      // Nothing to close.
    },
  };
}

function clientWith(
  stream: XdkClientLike["stream"],
  users: XdkClientLike["users"] = {
    getByUsername: async () => ({ data: null }),
  },
): XdkClientLike {
  return { users, stream };
}

test("maps XDK user lookup fields and response data", async () => {
  let requestedUsername = "";
  let requestedOptions: { userFields: string[] } | undefined;
  const api = createXApi(
    "bearer-token",
    clientWith(
      {
        getRules: async () => ({ data: [] }),
        updateRules: async () => undefined,
        posts: async () => emptyStream(),
      },
      {
        getByUsername: async (username, options) => {
          requestedUsername = username;
          requestedOptions = options;
          return { data: { id: "42", username: "alice", name: "Alice" } };
        },
      },
    ),
  );

  assert.deepEqual(await api.getUserByUsername("alice"), {
    id: "42",
    username: "alice",
    name: "Alice",
  });
  assert.equal(requestedUsername, "alice");
  assert.deepEqual(requestedOptions, { userFields: ["id", "username", "name"] });
});

test("loads every page of filtered-stream rules", async () => {
  const requests: Array<{ maxResults?: number; paginationToken?: string }> = [];
  const api = createXApi(
    "bearer-token",
    clientWith({
      getRules: async (options = {}) => {
        requests.push(options);
        if (!options.paginationToken) {
          return {
            data: [{ id: "first", value: "#first", tag: "one" }],
            meta: { nextToken: "page-2" },
          };
        }
        return {
          data: [
            { id: "second", value: "#second", tag: "two" },
            { id: "invalid", value: 123 },
          ],
        };
      },
      updateRules: async () => undefined,
      posts: async () => emptyStream(),
    }),
  );

  assert.deepEqual(await api.getStreamRules(), [
    { id: "first", value: "#first", tag: "one" },
    { id: "second", value: "#second", tag: "two" },
  ]);
  assert.deepEqual(requests, [
    { maxResults: 100 },
    { maxResults: 100, paginationToken: "page-2" },
  ]);
});

test("maps stream rule mutations and stream request options", async () => {
  const updates: unknown[] = [];
  let streamOptions: unknown;
  const expectedStream = emptyStream();
  const api = createXApi(
    "bearer-token",
    clientWith({
      getRules: async () => ({ data: [] }),
      updateRules: async (body) => {
        updates.push(body);
      },
      posts: async (options) => {
        streamOptions = options;
        return expectedStream;
      },
    }),
  );

  await api.addStreamRule("@bot !onboard", "test-rule");
  await api.deleteStreamRules(["rule-1", "rule-2"]);
  await api.deleteStreamRules([]);
  assert.equal(await api.streamPosts(), expectedStream);

  assert.deepEqual(updates, [
    { add: [{ value: "@bot !onboard", tag: "test-rule" }] },
    { delete: { ids: ["rule-1", "rule-2"] } },
  ]);
  assert.deepEqual(streamOptions, {
    tweetFields: [
      "id",
      "text",
      "author_id",
      "created_at",
      "conversation_id",
      "referenced_tweets",
    ],
    expansions: ["author_id"],
    userFields: ["id", "username", "name"],
  });
});
