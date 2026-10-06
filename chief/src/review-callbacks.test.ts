import assert from "node:assert/strict";
import test from "node:test";
import { createBot } from "./bot.js";
import type { ReviewDecisionInput } from "./review-decision-api.js";
import { ReviewDecisionError } from "./review-decision-api.js";
import type { ReviewDigest } from "./review-digest-api.js";

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "NEAR Builders",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
};

const ADMIN_CHAT = -100777;
const REVIEWER = 111;
const PROPOSAL = "proposal_1";

function digest(verdict: "ready" | "review" = "ready", submissionCount = 1): ReviewDigest {
  return {
    generatedAt: "2026-09-26T09:00:00.000Z",
    staleAfterDays: 7,
    totals: { pending: 1, newLast24h: 0, stale: 0, needsAttention: 0, oldestPendingDays: 1 },
    byPlugin: { builders: 0, projects: 1, events: 0, nearcatalog: 0 },
    activity: null,
    items: [
      {
        id: PROPOSAL,
        pluginId: "projects",
        entityId: "project-1",
        title: "NEAR <Rust> SDK",
        submittedBy: "alice.near",
        detail: null,
        submissionCount,
        evaluation: { verdict, score: 90, summary: "Solid.", flags: [], source: null },
        state: "pending",
        createdAt: "2026-09-25T09:00:00.000Z",
        ageDays: 1,
        isNew: false,
        isStale: false,
        dashboardPath: "/admin/dashboard/projects?item=project-1&status=pending",
      },
    ],
  };
}

interface Call {
  method: string;
  args: unknown[];
}

type DecisionReply = {
  decision: "approved" | "rejected" | "allowed";
  title: string;
  verdict?: "ready" | "review" | "spam" | null;
  summary?: string | null;
};

function websiteDecision(input: ReviewDecisionInput): DecisionReply {
  if (input.actor.telegramId !== REVIEWER) {
    throw new ReviewDecisionError("You are not an authorized reviewer", 403);
  }
  if (input.dryRun) {
    return { decision: "allowed", title: "NEAR <Rust> SDK", verdict: "ready", summary: "Solid." };
  }
  return { decision: input.decision === "approve" ? "approved" : "rejected", title: "NEAR <Rust> SDK" };
}

function setup(
  options: {
    reviewDigest?: () => Promise<ReviewDigest>;
    decideReview?: (input: ReviewDecisionInput) => Promise<DecisionReply>;
    pinned?: Record<string, unknown>;
  } = {},
) {
  const decisions: ReviewDecisionInput[] = [];
  const pinned = options.pinned;
  const bot = createBot("test-token", {
    reviewDigest: options.reviewDigest ?? (async () => digest()),
    adminChatId: String(ADMIN_CHAT),
    decideReview: async (input) => {
      decisions.push(input);
      return options.decideReview ? await options.decideReview(input) : websiteDecision(input);
    },
  });
  bot.botInfo = BOT_INFO as never;
  const calls: Call[] = [];
  const record =
    (method: string, result: unknown = true) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  Object.assign(bot.context, {
    telegram: {
      answerCbQuery: record("answerCbQuery"),
      sendMessage: record("sendMessage", { message_id: 50 }),
      editMessageText: record("editMessageText"),
      editMessageReplyMarkup: record("editMessageReplyMarkup"),
      deleteMessage: record("deleteMessage"),
      getChat: async (...args: unknown[]) => {
        calls.push({ method: "getChat", args });
        return pinned ? { id: ADMIN_CHAT, pinned_message: pinned } : { id: ADMIN_CHAT };
      },
    },
  });
  return { bot, calls, decisions };
}

const DIGEST_MESSAGE = {
  message_id: 40,
  date: 1,
  chat: { id: ADMIN_CHAT, type: "supergroup", title: "Admins" },
  from: { id: BOT_INFO.id, is_bot: true, first_name: "NEAR Builders" },
  text: "📋 NEAR Builders review queue: 1 pending",
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✅ Approve 1", callback_data: `rv:a:${PROPOSAL}:1` },
        { text: "❌ Reject 1", callback_data: `rv:r:${PROPOSAL}:1` },
      ],
      [{ text: "Open review dashboard", url: "https://nearbuilders.org/admin/dashboard" }],
    ],
  },
};

function tap(updateId: number, data: string, options: { fromId?: number; confirm?: boolean } = {}) {
  const message = options.confirm
    ? {
        message_id: 50,
        date: 1,
        chat: DIGEST_MESSAGE.chat,
        from: DIGEST_MESSAGE.from,
        text: "Approve?",
        reply_to_message: DIGEST_MESSAGE,
      }
    : DIGEST_MESSAGE;
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      chat_instance: "x",
      from: { id: options.fromId ?? REVIEWER, is_bot: false, first_name: "Saad", username: "saad" },
      message,
      data,
    },
  };
}

function methods(calls: Call[]) {
  return calls.map((call) => call.method);
}

test("refuses taps the website does not authorize, without posting anything", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(tap(1, `rv:a:${PROPOSAL}:1`, { fromId: 222 }) as never);
  assert.deepEqual(methods(calls), ["answerCbQuery"]);
  assert.equal(calls[0]!.args[1], "You are not an authorized reviewer");
  assert.deepEqual(calls[0]!.args[2], { show_alert: true });
  assert.deepEqual(
    decisions.map((input) => input.dryRun),
    [true],
  );
});

test("ignores review buttons outside the admin chat", async () => {
  const { bot, calls, decisions } = setup();
  const base = tap(9, `rv:a:${PROPOSAL}:1`);
  const update = {
    ...base,
    callback_query: {
      ...base.callback_query,
      message: {
        ...DIGEST_MESSAGE,
        chat: { id: -100123, type: "supergroup", title: "Other" },
      },
    },
  };
  await bot.handleUpdate(update as never);
  assert.deepEqual(methods(calls), ["answerCbQuery"]);
  assert.equal(decisions.length, 0);
});

test("asks for confirmation before approving", async () => {
  const { bot, calls } = setup();
  await bot.handleUpdate(tap(2, `rv:a:${PROPOSAL}:1`) as never);
  assert.deepEqual(methods(calls), ["answerCbQuery", "sendMessage"]);
  const [chatId, text, extra] = calls[1]!.args as [number, string, Record<string, unknown>];
  assert.equal(chatId, ADMIN_CHAT);
  assert.equal(text, "Approve <b>NEAR &lt;Rust&gt; SDK</b>? It will go live on nearbuilders.org.");
  assert.equal(extra.disable_notification, true);
  assert.deepEqual(extra.reply_parameters, { message_id: 40 });
  const buttons = (extra.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
    .inline_keyboard[0]!;
  assert.deepEqual(
    buttons.map((button) => button.callback_data),
    [`rv:ca:${PROPOSAL}:1`, "rv:x"],
  );
});

test("offers preset reasons before rejecting", async () => {
  const { bot, calls } = setup();
  await bot.handleUpdate(tap(3, `rv:r:${PROPOSAL}:1`) as never);
  const extra = calls[1]!.args[2] as { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } };
  assert.deepEqual(
    extra.reply_markup.inline_keyboard.flat().map((button) => button.text),
    ["Incomplete", "Not NEAR-related", "Spam", "Duplicate", "✍️ Custom reason", "Cancel"],
  );
});

test("does not offer actions the website says are no longer possible", async () => {
  const { bot, calls } = setup({
    decideReview: async () => {
      throw new ReviewDecisionError("Only items marked ready can be decided from Telegram", 403);
    },
  });
  await bot.handleUpdate(tap(4, `rv:a:${PROPOSAL}:1`) as never);
  assert.deepEqual(methods(calls), ["answerCbQuery"]);
  assert.equal(calls[0]!.args[1], "Only items marked ready can be decided from Telegram");
});

test("approves on confirm, records the result, and removes the item's buttons", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(tap(5, `rv:ca:${PROPOSAL}:1`, { confirm: true }) as never);

  assert.deepEqual(decisions, [
    {
      proposalId: PROPOSAL,
      submissionCount: 1,
      decision: "approve",
      actor: { telegramId: REVIEWER, username: "saad" },
    },
  ]);
  assert.equal(decisions[0]!.dryRun, undefined);
  assert.deepEqual(methods(calls), [
    "answerCbQuery",
    "editMessageText",
    "editMessageReplyMarkup",
    "getChat",
  ]);
  assert.equal(calls[1]!.args[3], "✅ <b>NEAR &lt;Rust&gt; SDK</b> approved by @saad.");
  assert.deepEqual(calls[2]!.args.slice(0, 2), [ADMIN_CHAT, 40]);
  assert.deepEqual(calls[2]!.args[3], {
    inline_keyboard: [
      [{ text: "Open review dashboard", url: "https://nearbuilders.org/admin/dashboard" }],
    ],
  });
});

test("rejects with the chosen reason", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(tap(6, `rv:cr:n:${PROPOSAL}:1`, { confirm: true }) as never);
  assert.equal(decisions[0]!.decision, "reject");
  assert.equal(decisions[0]!.reason, "not_near");
  assert.equal(calls[1]!.args[3], "❌ <b>NEAR &lt;Rust&gt; SDK</b> rejected (Not NEAR-related) by @saad.");
});

test("shows the website's reason when it refuses the decision", async () => {
  const { bot, calls } = setup({
    decideReview: async () => {
      throw new ReviewDecisionError("Only items marked ready can be decided from Telegram", 403);
    },
  });
  await bot.handleUpdate(tap(7, `rv:ca:${PROPOSAL}:1`, { confirm: true }) as never);
  assert.deepEqual(methods(calls), ["answerCbQuery", "editMessageText"]);
  assert.equal(
    calls[1]!.args[3],
    "⚠️ Couldn’t approve this item: Only items marked ready can be decided from Telegram",
  );
});

test("cancel removes the confirmation message", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(tap(8, "rv:x", { confirm: true }) as never);
  assert.deepEqual(methods(calls), ["answerCbQuery", "deleteMessage"]);
  assert.deepEqual(calls[1]!.args, [ADMIN_CHAT, 50]);
  assert.equal(decisions.length, 0);
});

test("opens a category list as a silent reply with per-item buttons", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(tap(10, "rv:l:r") as never);

  assert.deepEqual(methods(calls), ["answerCbQuery", "sendMessage"]);
  const [chatId, text, extra] = calls[1]!.args as [
    number,
    string,
    {
      disable_notification: boolean;
      reply_parameters: { message_id: number };
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
    },
  ];
  assert.equal(chatId, ADMIN_CHAT);
  assert.match(text, /^🟢 <b>Ready to approve<\/b> · 1\n\n<b>1\. NEAR &lt;Rust&gt; SDK<\/b>/);
  assert.equal(extra.disable_notification, true);
  assert.deepEqual(extra.reply_parameters, { message_id: 40 });
  assert.deepEqual(
    extra.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)),
    [["1 · NEAR <Rust> S… ↗", "✅ Approve", "❌ Reject"], ["🔄 Refresh", "✖ Close"]],
  );
  assert.equal(decisions.length, 0);
});

test("explains when the queue cannot be loaded for a list", async () => {
  const { bot, calls } = setup({
    reviewDigest: async () => {
      throw new Error("API down");
    },
  });
  await bot.handleUpdate(tap(11, "rv:l:n") as never);
  assert.deepEqual(methods(calls), ["answerCbQuery"]);
  assert.match(String(calls[0]!.args[1]), /Couldn’t load the review queue/);
});

test("warns before approving an item that was not marked ready", async () => {
  const { bot, calls } = setup({
    decideReview: async (input) =>
      input.dryRun
        ? {
            decision: "allowed",
            title: "Zara",
            verdict: "review",
            summary: "No on-chain account, no links",
          }
        : { decision: "approved", title: "Zara" },
  });
  await bot.handleUpdate(tap(20, `rv:a:${PROPOSAL}:1`) as never);
  assert.equal(
    calls[1]!.args[1],
    "⚠️ <b>Zara</b> wasn’t marked ready: <i>No on-chain account, no links</i>\nApprove anyway? It will go live on nearbuilders.org.",
  );
});

function listMessage(category = "n") {
  return {
    message_id: 60,
    date: 1,
    chat: DIGEST_MESSAGE.chat,
    from: DIGEST_MESSAGE.from,
    text: "🟡 Needs a look · 1",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "1 · Zara ↗", url: "https://nearbuilders.org/admin/dashboard/builders?item=z" },
          { text: "❌ Reject", callback_data: `rv:r:${PROPOSAL}:1` },
        ],
        [
          { text: "🔄 Refresh", callback_data: `rv:lr:${category}` },
          { text: "✖ Close", callback_data: "rv:x" },
        ],
      ],
    },
  };
}

function confirmTapOnList(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      chat_instance: "x",
      from: { id: REVIEWER, is_bot: false, first_name: "Saad", username: "saad" },
      message: {
        message_id: 70,
        date: 1,
        chat: DIGEST_MESSAGE.chat,
        from: DIGEST_MESSAGE.from,
        text: "Reject?",
        reply_to_message: listMessage(),
      },
      data,
    },
  };
}

test("re-renders the list and updates the pinned digest after a decision", async () => {
  const { bot, calls } = setup({
    reviewDigest: async () => ({ ...digest(), items: [] }),
    pinned: {
      message_id: 40,
      date: 1,
      chat: DIGEST_MESSAGE.chat,
      from: { id: BOT_INFO.id, is_bot: true, first_name: "NEAR Builders" },
      text: "📋 Review queue\n\n🟢 1 ready to approve",
    },
  });
  await bot.handleUpdate(confirmTapOnList(21, `rv:cr:i:${PROPOSAL}:1`) as never);

  assert.deepEqual(methods(calls), [
    "answerCbQuery",
    "editMessageText",
    "editMessageText",
    "getChat",
    "editMessageText",
  ]);
  const [listChat, listId, , listText, listExtra] = calls[2]!.args as [
    number,
    number,
    undefined,
    string,
    { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } },
  ];
  assert.deepEqual([listChat, listId], [ADMIN_CHAT, 60]);
  assert.equal(listText, "🟡 <b>Needs a look</b>\n\nNothing here right now.");
  assert.deepEqual(
    listExtra.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)),
    [["🔄 Refresh", "✖ Close"]],
  );
  assert.deepEqual(calls[4]!.args.slice(0, 2), [ADMIN_CHAT, 40]);
  assert.match(String(calls[4]!.args[3]), /^✅ Review queue is clear/);
});

test("refresh re-renders a list in place", async () => {
  const { bot, calls } = setup();
  const update = {
    update_id: 22,
    callback_query: {
      id: "cb22",
      chat_instance: "x",
      from: { id: REVIEWER, is_bot: false, first_name: "Saad", username: "saad" },
      message: listMessage("r"),
      data: "rv:lr:r",
    },
  };
  await bot.handleUpdate(update as never);
  assert.deepEqual(methods(calls), ["answerCbQuery", "editMessageText"]);
  assert.deepEqual(calls[1]!.args.slice(0, 2), [ADMIN_CHAT, 60]);
  assert.match(String(calls[1]!.args[3]), /^🟢 <b>Ready to approve<\/b> · 1/);
});

function reply(updateId: number, text: string, promptId: number, fromId = REVIEWER) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: DIGEST_MESSAGE.chat,
      from: { id: fromId, is_bot: false, first_name: "Saad", username: "saad" },
      text,
      reply_to_message: {
        message_id: promptId,
        date: 1,
        chat: DIGEST_MESSAGE.chat,
        from: DIGEST_MESSAGE.from,
        text: "✍️ Reply to this message with the reason for rejecting NEAR <Rust> SDK",
      },
    },
  };
}

test("rejects with a custom reason typed as a reply", async () => {
  const { bot, calls, decisions } = setup();
  await bot.handleUpdate(confirmTapOnList(23, `rv:cc:${PROPOSAL}:1`) as never);

  assert.deepEqual(methods(calls), ["answerCbQuery", "sendMessage", "deleteMessage"]);
  const [, promptText, promptExtra] = calls[1]!.args as [
    number,
    string,
    { reply_markup: unknown; disable_notification: boolean },
  ];
  assert.match(promptText, /^✍️ Reply to this message with the reason for rejecting <b>NEAR &lt;Rust&gt; SDK<\/b>/);
  assert.match(promptText, /<a href="tg:\/\/user\?id=111">Saad<\/a>/);
  assert.deepEqual(promptExtra.reply_markup, { force_reply: true, selective: true });

  calls.length = 0;
  await bot.handleUpdate(reply(24, "  Please add a link to your GitHub.  ", 50, 222) as never);
  assert.equal(calls.length, 0);

  await bot.handleUpdate(reply(25, "no", 50) as never);
  assert.match(String(calls[0]!.args[1]), /needs 3–500 characters/);

  calls.length = 0;
  await bot.handleUpdate(reply(26, "  Please add a link to your GitHub.  ", 50) as never);
  const last = decisions.at(-1)!;
  assert.equal(last.decision, "reject");
  assert.equal(last.customReason, "Please add a link to your GitHub.");
  assert.equal(last.dryRun, undefined);
  assert.equal(calls[0]!.method, "editMessageText");
  assert.deepEqual(calls[0]!.args.slice(0, 2), [ADMIN_CHAT, 50]);
  assert.equal(
    calls[0]!.args[3],
    "❌ <b>NEAR &lt;Rust&gt; SDK</b> rejected (Please add a link to your GitHub.) by @saad.",
  );
  assert.ok(methods(calls).includes("editMessageText"));

  calls.length = 0;
  await bot.handleUpdate(reply(27, "Another reason entirely", 50) as never);
  assert.match(String(calls[0]!.args[1]), /expired/);
});
