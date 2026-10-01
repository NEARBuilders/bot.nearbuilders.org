import assert from "node:assert/strict";
import test from "node:test";
import { createBot } from "./bot.js";
import type { TelegramLinkInput, TelegramLinkResult } from "./review-link-api.js";

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
const USER = { id: 456, is_bot: false, first_name: "Saad", username: "saad" };

interface Call {
  method: string;
  args: unknown[];
}

function setup(
  options: {
    memberStatus?: string;
    adminChatId?: string;
    requestLink?: (input: TelegramLinkInput) => Promise<TelegramLinkResult>;
  } = {},
) {
  const requests: TelegramLinkInput[] = [];
  const bot = createBot("test-token", {
    adminChatId: options.adminChatId ?? String(ADMIN_CHAT),
    requestTelegramLink: async (input) => {
      requests.push(input);
      return options.requestLink
        ? options.requestLink(input)
        : {
            url: "https://nearbuilders.org/admin/telegram-link?code=abc",
            expiresAt: "2026-09-30T08:10:00.000Z",
            linkedAs: null,
          };
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
  return { bot, calls, requests };
}

function link(updateId: number, chat: { id: number; type: string }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: chat.type === "private" ? { ...chat, first_name: "Saad" } : { ...chat, title: "G" },
      from: USER,
      text: "/link",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  };
}

const PRIVATE = { id: USER.id, type: "private" };

function replies(calls: Call[]) {
  return calls.filter((call) => call.method === "sendMessage");
}

test("/link sends an admin group member a one-time link button", async () => {
  const { bot, calls, requests } = setup();
  await bot.handleUpdate(link(1, PRIVATE) as never);

  assert.deepEqual(requests, [{ telegramId: 456, username: "saad", name: "Saad" }]);
  assert.deepEqual(calls[0], { method: "getChatMember", args: [String(ADMIN_CHAT), 456] });
  const [reply] = replies(calls);
  const [chatId, text, extra] = reply!.args as [number, string, Record<string, any>];
  assert.equal(chatId, USER.id);
  assert.match(text, /signed in to nearbuilders\.org as an admin/);
  assert.match(text, /10 minutes/);
  const [[button]] = extra.reply_markup.inline_keyboard;
  assert.equal(button.text, "🔗 Link my account");
  assert.equal(button.url, "https://nearbuilders.org/admin/telegram-link?code=abc");
});

test("/link says which account it is already linked to", async () => {
  const { bot, calls } = setup({
    requestLink: async () => ({
      url: "https://nearbuilders.org/admin/telegram-link?code=abc",
      expiresAt: "2026-09-30T08:10:00.000Z",
      linkedAs: "admin.near",
    }),
  });
  await bot.handleUpdate(link(2, PRIVATE) as never);
  assert.match(String(replies(calls)[0]!.args[1]), /already linked to <b>admin\.near<\/b>/);
});

test("/link refuses people outside the admin group", async () => {
  for (const status of ["left", "kicked"]) {
    const { bot, calls, requests } = setup({ memberStatus: status });
    await bot.handleUpdate(link(3, PRIVATE) as never);
    assert.equal(requests.length, 0);
    assert.match(String(replies(calls)[0]!.args[1]), /Only members of the admin group/);
  }
});

test("/link in the admin group points to a private chat and ignores other groups", async () => {
  const { bot, calls, requests } = setup();
  await bot.handleUpdate(link(4, { id: ADMIN_CHAT, type: "supergroup" }) as never);
  await bot.handleUpdate(link(5, { id: OTHER_CHAT, type: "supergroup" }) as never);

  assert.equal(requests.length, 0);
  const sent = replies(calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.args[0], ADMIN_CHAT);
  assert.match(String(sent[0]!.args[1]), /private chat/);
});

test("/link explains when the website cannot create a link", async () => {
  const { bot, calls } = setup({
    requestLink: async () => {
      throw new Error("down");
    },
  });
  await bot.handleUpdate(link(6, PRIVATE) as never);
  assert.match(String(replies(calls)[0]!.args[1]), /Couldn’t create a link/);
});

test("/link reports when no admin group is configured", async () => {
  const { bot, calls, requests } = setup({ adminChatId: "" });
  await bot.handleUpdate(link(7, PRIVATE) as never);
  assert.equal(requests.length, 0);
  assert.match(String(replies(calls)[0]!.args[1]), /isn’t set up/);
});
