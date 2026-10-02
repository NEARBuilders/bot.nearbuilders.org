import assert from "node:assert/strict";
import test from "node:test";
import { TelegramError } from "telegraf";
import { runDigestJob, type DigestJobDependencies } from "./digest-job.js";
import type { ReviewDigest } from "./review-digest-api.js";

const EMPTY: ReviewDigest = {
  generatedAt: "2026-09-26T09:00:00.000Z",
  staleAfterDays: 7,
  totals: {
    pending: 0,
    newLast24h: 0,
    stale: 0,
    needsAttention: 0,
    oldestPendingDays: null,
  },
  byPlugin: { builders: 0, projects: 0, events: 0, nearcatalog: 0 },
  activity: null,
  items: [],
};

const PENDING: ReviewDigest = {
  ...EMPTY,
  totals: {
    pending: 1,
    newLast24h: 1,
    stale: 0,
    needsAttention: 0,
    oldestPendingDays: 0,
  },
  byPlugin: { builders: 1, projects: 0, events: 0, nearcatalog: 0 },
  items: [
    {
      id: "proposal-1",
      pluginId: "builders",
      entityId: "alice.near",
      title: "Alice",
      submittedBy: "bob.near",
      detail: null,
      submissionCount: 1,
      evaluation: null,
      state: "pending",
      createdAt: "2026-09-26T08:00:00.000Z",
      ageDays: 0,
      isNew: true,
      isStale: false,
      dashboardPath: "/admin/dashboard/builders?item=alice.near&status=pending",
    },
  ],
};

type SentMessage = Parameters<DigestJobDependencies["sendMessage"]>;

function dependencies(fetchDigest: () => Promise<ReviewDigest>) {
  const sent: SentMessage[] = [];
  return {
    sent,
    deps: {
      adminChatId: "-100123",
      siteUrl: "https://nearbuilders.org/",
      fetchDigest,
      sendMessage: async (...args: SentMessage) => {
        sent.push(args);
      },
    } satisfies DigestJobDependencies,
  };
}

const TUESDAY = () => new Date("2026-09-29T10:00:00.000Z");
const MONDAY = () => new Date("2026-09-28T10:00:00.000Z");

test("sends nothing when the queue is empty on a normal weekday", async () => {
  const { sent, deps } = dependencies(async () => EMPTY);
  assert.equal(await runDigestJob({ ...deps, now: TUESDAY }), "skipped_empty");
  assert.equal(sent.length, 0);
});

test("sends one silent all-clear when the queue is empty on Monday", async () => {
  const { sent, deps } = dependencies(async () => EMPTY);
  assert.equal(await runDigestJob({ ...deps, now: MONDAY }), "all_clear_sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1], /^✅ Review queue is clear/);
  assert.equal(sent[0]![2].disable_notification, true);
});

test("sends the normal digest on Monday when items are pending", async () => {
  const { sent, deps } = dependencies(async () => PENDING);
  assert.equal(await runDigestJob({ ...deps, now: MONDAY }), "sent");
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0]![1], /Review queue is clear/);
});

test("sends exactly one HTML message with a dashboard button", async () => {
  const { sent, deps } = dependencies(async () => PENDING);
  assert.equal(await runDigestJob(deps), "sent");
  assert.equal(sent.length, 1);

  const [chatId, text, extra] = sent[0]!;
  assert.equal(chatId, "-100123");
  assert.equal(text, "📋 <b>Review queue</b>\n\n🕒 <b>1</b> pending");
  assert.equal(extra.parse_mode, "HTML");
  assert.equal(extra.disable_notification, false);
  assert.deepEqual(extra.link_preview_options, { is_disabled: true });
  assert.deepEqual(extra.reply_markup, {
    inline_keyboard: [
      [{ text: "🕒 Pending (1)", callback_data: "rv:l:p", hide: false }],
      [
        {
          text: "Open review dashboard",
          url: "https://nearbuilders.org/admin/dashboard",
          hide: false,
        },
      ],
    ],
  });
});

test("sends one silent failure notice when the digest cannot be fetched", async () => {
  const { sent, deps } = dependencies(async () => {
    throw new Error("API down");
  });
  assert.equal(await runDigestJob(deps), "failure_notified");
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1], /Couldn’t build today’s review digest/);
  assert.match(sent[0]![1], /https:\/\/nearbuilders\.org\/admin\/dashboard$/);
  assert.equal(sent[0]![2].disable_notification, true);
  assert.equal(sent[0]![2].reply_markup, undefined);
});

test("falls back to a plain failure notice when Telegram rejects the digest", async () => {
  const { sent, deps } = dependencies(async () => PENDING);
  let attempts = 0;
  const outcome = await runDigestJob({
    ...deps,
    sendMessage: async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        throw new TelegramError({
          error_code: 400,
          description: "Bad Request: inline keyboard button URL is invalid",
        });
      }
      sent.push(args);
    },
  });

  assert.equal(outcome, "failure_notified");
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1], /Couldn’t build today’s review digest/);
  assert.equal(sent[0]![2].parse_mode, undefined);
});

function pinHarness(current: { messageId: number; isOwnDigest: boolean } | null) {
  const calls: string[] = [];
  return {
    calls,
    pins: {
      current: async () => {
        calls.push("current");
        return current;
      },
      pin: async (messageId: number) => {
        calls.push(`pin ${messageId}`);
      },
      remove: async (messageId: number) => {
        calls.push(`remove ${messageId}`);
      },
    },
  };
}

function sendingId(id: number, deps: DigestJobDependencies) {
  return {
    ...deps,
    sendMessage: async (...args: SentMessage) => {
      await deps.sendMessage(...args);
      return { message_id: id };
    },
  };
}

test("pins the new digest and removes the previous digest", async () => {
  const { deps } = dependencies(async () => PENDING);
  const { calls, pins } = pinHarness({ messageId: 41, isOwnDigest: true });
  assert.equal(await runDigestJob({ ...sendingId(42, deps), pins }), "sent");
  assert.deepEqual(calls, ["current", "pin 42", "remove 41"]);
});

test("keeps pins that are not the bot's own digest", async () => {
  const { deps } = dependencies(async () => PENDING);
  const { calls, pins } = pinHarness({ messageId: 7, isOwnDigest: false });
  await runDigestJob({ ...sendingId(42, deps), pins });
  assert.deepEqual(calls, ["current", "pin 42"]);
});

test("pins the Monday all-clear too", async () => {
  const { deps } = dependencies(async () => EMPTY);
  const { calls, pins } = pinHarness({ messageId: 41, isOwnDigest: true });
  assert.equal(
    await runDigestJob({ ...sendingId(43, deps), pins, now: MONDAY }),
    "all_clear_sent",
  );
  assert.deepEqual(calls, ["current", "pin 43", "remove 41"]);
});

test("a failed pin never fails the digest or removes the old pin", async () => {
  const { sent, deps } = dependencies(async () => PENDING);
  const calls: string[] = [];
  const outcome = await runDigestJob({
    ...sendingId(42, deps),
    pins: {
      current: async () => ({ messageId: 41, isOwnDigest: true }),
      pin: async () => {
        throw new TelegramError({
          error_code: 400,
          description: "Bad Request: not enough rights to manage pinned messages",
        });
      },
      remove: async (messageId) => {
        calls.push(`remove ${messageId}`);
      },
    },
  });
  assert.equal(outcome, "sent");
  assert.equal(sent.length, 1);
  assert.deepEqual(calls, []);
});

test("does not pin failure notices", async () => {
  const { deps } = dependencies(async () => {
    throw new Error("API down");
  });
  const { calls, pins } = pinHarness({ messageId: 41, isOwnDigest: true });
  await runDigestJob({ ...sendingId(44, deps), pins });
  assert.deepEqual(calls, []);
});
