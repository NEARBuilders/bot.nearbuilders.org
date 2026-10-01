import assert from "node:assert/strict";
import test from "node:test";
import { createBot, setCommandMenus } from "./bot.js";
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
const OTHER_CHAT = -100123;

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

interface Call {
  method: string;
  args: unknown[];
}

function setup(reviewDigest: () => Promise<ReviewDigest>) {
  const bot = createBot("test-token", {
    reviewDigest,
    adminChatId: String(ADMIN_CHAT),
  });
  bot.botInfo = BOT_INFO as never;
  const calls: Call[] = [];
  Object.assign(bot.context, {
    telegram: {
      sendMessage: async (...args: unknown[]) => {
        calls.push({ method: "sendMessage", args });
        return { message_id: 1 };
      },
      deleteMessage: async (...args: unknown[]) => {
        calls.push({ method: "deleteMessage", args });
        return true;
      },
    },
  });
  return { bot, calls };
}

function command(updateId: number, chatId: number, text = "/pending") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: "supergroup", title: "Admins" },
      from: { id: 456, is_bot: false, first_name: "Admin" },
      text,
      entities: [{ offset: 0, length: text.length, type: "bot_command" }],
    },
  };
}

function pinNotice(updateId: number, chatId: number, fromId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chatId, type: "supergroup", title: "Admins" },
      from: { id: fromId, is_bot: fromId === BOT_INFO.id, first_name: "X" },
      pinned_message: {
        message_id: 5,
        date: 1,
        chat: { id: chatId, type: "supergroup", title: "Admins" },
        text: "📋 NEAR Builders review queue: 1 pending",
      },
    },
  };
}

test("/pending replies with the live digest in the admin chat", async () => {
  const { bot, calls } = setup(async () => PENDING);
  await bot.handleUpdate(command(1, ADMIN_CHAT) as never);

  assert.equal(calls.length, 1);
  const [chatId, text, extra] = calls[0]!.args as [
    number,
    string,
    Record<string, unknown>,
  ];
  assert.equal(chatId, ADMIN_CHAT);
  assert.equal(text, "📋 <b>Review queue</b>\n\n🕒 <b>1</b> pending");
  assert.equal(extra.parse_mode, "HTML");
});

test("/pending reports an empty queue in one line", async () => {
  const { bot, calls } = setup(async () => EMPTY);
  await bot.handleUpdate(command(2, ADMIN_CHAT) as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args[1], "✅ Nothing is waiting for review.");
});

test("/pending is ignored outside the admin chat", async () => {
  let fetched = false;
  const { bot, calls } = setup(async () => {
    fetched = true;
    return PENDING;
  });
  await bot.handleUpdate(command(3, OTHER_CHAT) as never);
  assert.equal(fetched, false);
  assert.equal(calls.length, 0);
});

test("/pending explains when the queue cannot be loaded", async () => {
  const { bot, calls } = setup(async () => {
    throw new Error("API down");
  });
  await bot.handleUpdate(command(4, ADMIN_CHAT) as never);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]!.args[1]), /Couldn’t load the review queue/);
});

test("deletes the bot's own pin notices in the admin chat only", async () => {
  const { bot, calls } = setup(async () => PENDING);
  await bot.handleUpdate(pinNotice(10, ADMIN_CHAT, BOT_INFO.id) as never);
  await bot.handleUpdate(pinNotice(11, ADMIN_CHAT, 456) as never);
  await bot.handleUpdate(pinNotice(12, OTHER_CHAT, BOT_INFO.id) as never);

  assert.deepEqual(calls, [
    { method: "deleteMessage", args: [ADMIN_CHAT, 10] },
  ]);
});

test("/start in a private chat explains the bot and points admins to /link", async () => {
  const { bot, calls } = setup(async () => EMPTY);
  await bot.handleUpdate({
    update_id: 20,
    message: {
      message_id: 20,
      date: 1,
      chat: { id: 456, type: "private", first_name: "Admin" },
      from: { id: 456, is_bot: false, first_name: "Admin" },
      text: "/start",
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  } as never);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]!.args[1]), /send \/link/);
});

test("shows /link in private chats and /pending only in the admin chat", async () => {
  const { bot } = setup(async () => EMPTY);
  const menus: unknown[][] = [];
  bot.telegram.setMyCommands = (async (...args: unknown[]) => {
    menus.push(args);
    return true;
  }) as never;
  await setCommandMenus(bot, String(ADMIN_CHAT));

  const byScope = new Map(
    menus.map(([commands, extra]) => [
      JSON.stringify((extra as { scope: unknown }).scope),
      (commands as { command: string }[]).map((entry) => entry.command),
    ]),
  );
  assert.deepEqual(byScope.get(JSON.stringify({ type: "all_private_chats" })), ["link"]);
  assert.deepEqual(byScope.get(JSON.stringify({ type: "all_group_chats" })), []);
  assert.deepEqual(
    byScope.get(JSON.stringify({ type: "chat", chat_id: String(ADMIN_CHAT) })),
    ["pending"],
  );
});
