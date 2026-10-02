import assert from "node:assert/strict";
import test from "node:test";
import { createBot } from "./bot.js";
import { ReviewDecisionError } from "./review-decision-api.js";
import type { TelegramLinkClaim, TelegramLinkResult } from "./review-link-api.js";

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "Chief",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
};

const ADMIN_CHAT = -100777;
const OTHER_CHAT = -100123;
const USER = { id: 456, is_bot: false, first_name: "Saad", username: "saad" };
const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

interface Call {
  method: string;
  args: unknown[];
}

function setup(
  options: {
    memberStatus?: string;
    adminChatId?: string;
    claim?: (input: TelegramLinkClaim) => Promise<TelegramLinkResult>;
  } = {},
) {
  const claims: TelegramLinkClaim[] = [];
  const bot = createBot("test-token", {
    adminChatId: options.adminChatId ?? String(ADMIN_CHAT),
    claimTelegramLink: async (input) => {
      claims.push(input);
      return options.claim ? options.claim(input) : { userLabel: "admin.near" };
    },
  });
  bot.botInfo = BOT_INFO as never;
  const calls: Call[] = [];
  Object.assign(bot.context, {
    telegram: {
      sendMessage: async (...args: unknown[]) => {
        calls.push({ method: "sendMessage", args });
        return { message_id: 1 };
      },
      getChatMember: async (...args: unknown[]) => {
        calls.push({ method: "getChatMember", args });
        return { status: options.memberStatus ?? "member", user: USER };
      },
    },
  });
  return { bot, calls, claims };
}

function message(updateId: number, chat: { id: number; type: string }, text: string) {
  const command = text.split(" ")[0]!;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: chat.type === "private" ? { ...chat, first_name: "Saad" } : { ...chat, title: "G" },
      from: USER,
      text,
      entities: [{ offset: 0, length: command.length, type: "bot_command" }],
    },
  };
}

const PRIVATE = { id: USER.id, type: "private" };

function replies(calls: Call[]) {
  return calls.filter((call) => call.method === "sendMessage").map((call) => String(call.args[1]));
}

test("/link <code> links an admin group member and names the admin account", async () => {
  const { bot, calls, claims } = setup();
  await bot.handleUpdate(message(1, PRIVATE, `/link ${CODE}`) as never);

  assert.deepEqual(claims, [{ code: CODE, telegramId: 456, username: "saad", name: "Saad" }]);
  assert.deepEqual(calls[0], { method: "getChatMember", args: [String(ADMIN_CHAT), 456] });
  assert.match(replies(calls)[0]!, /✅ Linked\..*<b>admin\.near<\/b>/);
});

test("opening Chief from the dashboard link claims the code too", async () => {
  const { bot, claims } = setup();
  await bot.handleUpdate(message(2, PRIVATE, `/start link-${CODE}`) as never);
  assert.equal(claims[0]?.code, CODE);
});

test("/link without a code explains where to get one", async () => {
  const { bot, calls, claims } = setup();
  await bot.handleUpdate(message(3, PRIVATE, "/link") as never);
  assert.equal(claims.length, 0);
  assert.match(replies(calls)[0]!, /Admin Dashboard → Telegram/);
});

test("/link rejects malformed codes without calling the website", async () => {
  const { bot, calls, claims } = setup();
  await bot.handleUpdate(message(4, PRIVATE, "/link nope") as never);
  assert.equal(claims.length, 0);
  assert.match(replies(calls)[0]!, /doesn’t look right/);
});

test("/link refuses people outside the admin group", async () => {
  for (const status of ["left", "kicked"]) {
    const { bot, calls, claims } = setup({ memberStatus: status });
    await bot.handleUpdate(message(5, PRIVATE, `/link ${CODE}`) as never);
    assert.equal(claims.length, 0);
    assert.match(replies(calls)[0]!, /Only members of the admin group/);
  }
});

test("/link in the admin group points to a private chat and ignores other groups", async () => {
  const { bot, calls, claims } = setup();
  await bot.handleUpdate(message(6, { id: ADMIN_CHAT, type: "supergroup" }, `/link ${CODE}`) as never);
  await bot.handleUpdate(message(7, { id: OTHER_CHAT, type: "supergroup" }, "/link") as never);

  assert.equal(claims.length, 0);
  const sent = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.args[0], ADMIN_CHAT);
  assert.match(String(sent[0]!.args[1]), /private chat/);
});

test("/link shows the website's reason for an expired code", async () => {
  const { bot, calls } = setup({
    claim: async () => {
      throw new ReviewDecisionError("This code has expired or was already used.", 404);
    },
  });
  await bot.handleUpdate(message(8, PRIVATE, `/link ${CODE}`) as never);
  assert.match(replies(calls)[0]!, /expired or was already used/);
});

test("/link hides server errors behind a retry message", async () => {
  const { bot, calls } = setup({
    claim: async () => {
      throw new Error("socket hang up");
    },
  });
  await bot.handleUpdate(message(9, PRIVATE, `/link ${CODE}`) as never);
  assert.match(replies(calls)[0]!, /Couldn’t reach nearbuilders\.org/);
});

test("/link reports when no admin group is configured", async () => {
  const { bot, calls, claims } = setup({ adminChatId: "" });
  await bot.handleUpdate(message(10, PRIVATE, `/link ${CODE}`) as never);
  assert.equal(claims.length, 0);
  assert.match(replies(calls)[0]!, /isn’t set up/);
});
