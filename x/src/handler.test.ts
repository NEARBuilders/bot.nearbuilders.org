import assert from "node:assert/strict";
import test from "node:test";
import {
  handlePostEvent,
  extractPostEvent,
} from "./handler.js";
import type { XNomination } from "./nomination-api.js";
import { XApiError, type XApi } from "./x-api.js";

const event = {
  data: {
    id: "123456789",
    text: "@NEARBuilders !onboard @alice",
    author_id: "987654321",
    created_at: "2026-08-04T13:00:00.000Z",
    conversation_id: "123456789",
    referenced_tweets: [{ type: "replied_to", id: "111111111" }],
  },
  includes: {
    users: [
      { id: "987654321", username: "bob", name: "Bob" },
    ],
  },
};

function nomination(created: boolean): XNomination {
  return {
    nominationId: "nom_123",
    created,
  };
}

type HandlerXApi = Pick<XApi, "getUserByUsername" | "getPostAuthor" | "likePost">;

function xApi(overrides: Partial<HandlerXApi> = {}): HandlerXApi {
  return {
    getUserByUsername: async () => null,
    getPostAuthor: async () => null,
    likePost: async () => undefined,
    ...overrides,
  };
}

test("extracts the post author and reply context", () => {
  assert.deepEqual(extractPostEvent(event), {
    id: "123456789",
    text: "@NEARBuilders !onboard @alice",
    authorId: "987654321",
    authorUsername: "bob",
    createdAt: "2026-08-04T13:00:00.000Z",
    conversationId: "123456789",
    replyToPostId: "111111111",
  });
});

test("resolves the nominee and sends complete attribution to the API", async () => {
  let request: unknown;
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: xApi({
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
    }),
    nominations: {
      createNomination: async (input) => {
        request = input;
        return nomination(true);
      },
    },
  });

  assert.equal(result, "created");
  assert.deepEqual(request, {
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
    replyToPostId: "111111111",
  });
});

test("onboards the author of the replied-to post and likes the command post", async () => {
  let requestedPostId = "";
  let likedPostId = "";
  let request: unknown;
  const replyEvent = {
    ...event,
    data: {
      ...event.data,
      text: "@NearBuilders !onboard",
    },
  };

  const result = await handlePostEvent(replyEvent, {
    botUsername: "nearbuilders",
    x: xApi({
      getPostAuthor: async (postId) => {
        requestedPostId = postId;
        return { id: "456789123", username: "alice", name: "Alice" };
      },
      likePost: async (postId) => {
        likedPostId = postId;
      },
    }),
    nominations: {
      createNomination: async (input) => {
        request = input;
        return nomination(true);
      },
    },
  });

  assert.equal(result, "created");
  assert.equal(requestedPostId, "111111111");
  assert.equal(likedPostId, "123456789");
  assert.deepEqual(request, {
    source: "x",
    sourceNominationId: "123456789",
    sourcePostUrl: "https://x.com/i/web/status/123456789",
    sourcePostText: "@NearBuilders !onboard",
    sourcePostCreatedAt: "2026-08-04T13:00:00.000Z",
    nominatedByXId: "987654321",
    nominatedByXUsername: "bob",
    nomineeXId: "456789123",
    nomineeXUsername: "alice",
    conversationId: "123456789",
    replyToPostId: "111111111",
  });
});

test("likes explicit nominations after an idempotent replay", async () => {
  const liked: string[] = [];
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: xApi({
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
      likePost: async (postId) => {
        liked.push(postId);
      },
    }),
    nominations: { createNomination: async () => nomination(false) },
  });

  assert.equal(result, "replayed");
  assert.deepEqual(liked, ["123456789"]);
});

test("keeps a persisted nomination successful when liking is forbidden", async () => {
  let likeCalls = 0;
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: xApi({
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
      likePost: async () => {
        likeCalls += 1;
        throw new XApiError("forbidden", 403);
      },
    }),
    nominations: { createNomination: async () => nomination(true) },
  });

  assert.equal(result, "created");
  assert.equal(likeCalls, 1);
});

test("does not create a nomination for an unavailable nominee", async () => {
  let calls = 0;
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: xApi(),
    nominations: {
      createNomination: async () => {
        calls += 1;
        return nomination(true);
      },
    },
  });
  assert.equal(result, "ignored");
  assert.equal(calls, 0);
});

test("reports an API persistence failure separately from lookup failures", async () => {
  let likes = 0;
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: xApi({
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
      likePost: async () => {
        likes += 1;
      },
    }),
    nominations: {
      createNomination: async () => {
        throw new Error("API unavailable");
      },
    },
  });
  assert.equal(result, "api_failed");
  assert.equal(likes, 0);
});

test("ignores reply shorthand when the post is not a reply", async () => {
  const result = await handlePostEvent(
    {
      data: {
        id: "123456789",
        text: "@NearBuilders !onboard",
        author_id: "987654321",
      },
      includes: { users: [{ id: "987654321", username: "bob" }] },
    },
    {
      botUsername: "nearbuilders",
      x: xApi({
        getPostAuthor: async () => {
          throw new Error("must not be called");
        },
      }),
      nominations: { createNomination: async () => nomination(true) },
    },
  );

  assert.equal(result, "ignored");
});

test("ignores malformed and implicit events", async () => {
  assert.equal(
    await handlePostEvent(
      { data: { id: "1", text: "@NEARBuilders !onboard", author_id: "2" } },
      {
        botUsername: "nearbuilders",
        x: xApi(),
        nominations: { createNomination: async () => nomination(true) },
      },
    ),
    "ignored",
  );
});
