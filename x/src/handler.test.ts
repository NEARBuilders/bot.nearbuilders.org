import assert from "node:assert/strict";
import test from "node:test";
import {
  handlePostEvent,
  extractPostEvent,
} from "./handler.js";
import type { XNomination } from "./nomination-api.js";

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
    x: {
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
    },
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

test("does not create a nomination for an unavailable nominee", async () => {
  let calls = 0;
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: { getUserByUsername: async () => null },
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
  const result = await handlePostEvent(event, {
    botUsername: "nearbuilders",
    x: {
      getUserByUsername: async () => ({ id: "456789123", username: "alice", name: "Alice" }),
    },
    nominations: {
      createNomination: async () => {
        throw new Error("API unavailable");
      },
    },
  });
  assert.equal(result, "api_failed");
});

test("ignores malformed and implicit events", async () => {
  assert.equal(
    await handlePostEvent(
      { data: { id: "1", text: "@NEARBuilders !onboard", author_id: "2" } },
      {
        botUsername: "nearbuilders",
        x: { getUserByUsername: async () => null },
        nominations: { createNomination: async () => nomination(true) },
      },
    ),
    "ignored",
  );
});
