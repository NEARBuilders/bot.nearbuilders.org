import assert from "node:assert/strict";
import test from "node:test";
import {
  createXApi,
  XApiError,
  type XdkClientLike,
  type XStream,
} from "./x-api.js";

const credentials = {
  bearerToken: "bearer-token",
  consumerKey: "consumer-key",
  consumerKeySecret: "consumer-key-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-token-secret",
  botUsername: "nearbuilders",
};

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
    getMe: async () => ({ data: { id: "bot-id", username: "nearbuilders" } }),
    likePost: async () => ({ data: { liked: true } }),
  },
  posts: XdkClientLike["posts"] = {
    getById: async () => ({ data: null }),
  },
): XdkClientLike {
  return { users, posts, stream };
}

test("maps XDK user lookup fields and response data", async () => {
  let requestedUsername = "";
  let requestedOptions: { userFields: string[] } | undefined;
  const api = createXApi(
    credentials,
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
        getMe: async () => ({ data: { id: "bot-id", username: "nearbuilders" } }),
        likePost: async () => ({ data: { liked: true } }),
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
    credentials,
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
    credentials,
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

test("resolves the author expanded from a replied-to post", async () => {
  let requestedPostId = "";
  let requestedOptions: unknown;
  const api = createXApi(
    credentials,
    clientWith(
      {
        getRules: async () => ({ data: [] }),
        updateRules: async () => undefined,
        posts: async () => emptyStream(),
      },
      undefined,
      {
        getById: async (postId, options) => {
          requestedPostId = postId;
          requestedOptions = options;
          return {
            data: { id: postId, authorId: "author-id" },
            includes: {
              users: [{ id: "author-id", username: "alice", name: "Alice" }],
            },
          };
        },
      },
    ),
  );

  assert.deepEqual(await api.getPostAuthor("parent-post"), {
    id: "author-id",
    username: "alice",
    name: "Alice",
  });
  assert.equal(requestedPostId, "parent-post");
  assert.deepEqual(requestedOptions, {
    expansions: ["author_id"],
    userFields: ["id", "username", "name"],
  });
});

test("likes posts as the authenticated user and caches its ID", async () => {
  let getMeCalls = 0;
  const likes: Array<{ userId: string; tweetId: string }> = [];
  const api = createXApi(
    credentials,
    clientWith(
      {
        getRules: async () => ({ data: [] }),
        updateRules: async () => undefined,
        posts: async () => emptyStream(),
      },
      {
        getByUsername: async () => ({ data: null }),
        getMe: async () => {
          getMeCalls += 1;
          return { data: { id: "bot-id", username: "nearbuilders", name: "NEAR Builders" } };
        },
        likePost: async (userId, body) => {
          likes.push({ userId, tweetId: body.tweetId });
          return { data: { liked: true } };
        },
      },
    ),
  );

  await api.likePost("post-1");
  await api.likePost("post-2");

  assert.equal(getMeCalls, 1);
  assert.deepEqual(likes, [
    { userId: "bot-id", tweetId: "post-1" },
    { userId: "bot-id", tweetId: "post-2" },
  ]);
});

test("refuses to like from an access token belonging to another account", async () => {
  let likeCalls = 0;
  const api = createXApi(
    credentials,
    clientWith(
      {
        getRules: async () => ({ data: [] }),
        updateRules: async () => undefined,
        posts: async () => emptyStream(),
      },
      {
        getByUsername: async () => ({ data: null }),
        getMe: async () => ({
          data: { id: "personal-id", username: "personal_account" },
        }),
        likePost: async () => {
          likeCalls += 1;
          return { data: { liked: true } };
        },
      },
    ),
  );

  await assert.rejects(
    api.likePost("post-1"),
    (error: unknown) =>
      error instanceof XApiError &&
      error.status === 403 &&
      error.message.includes("expected @nearbuilders"),
  );
  assert.equal(likeCalls, 0);
});
