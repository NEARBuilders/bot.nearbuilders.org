import assert from "node:assert/strict";
import test from "node:test";
import { TelegramError } from "telegraf";
import { clearCommandMenus, createBot, type BotDependencies } from "./bot.js";
import type { Nomination } from "./nomination-api.js";

const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "NEAR Builders",
  username: "testbot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
};

interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

function messageResult(chatId: number, text: string) {
  return {
    message_id: 900,
    date: 1,
    chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
    text,
  };
}

function setupBot(
  nominations: BotDependencies["nominations"],
  telegramFailure?: (
    method: string,
    payload: Record<string, unknown>,
  ) => unknown,
) {
  const bot = createBot("test-token", { nominations });
  bot.botInfo = BOT_INFO as never;
  const calls: TelegramCall[] = [];
  const callApi = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    const failure = telegramFailure?.(method, payload);
    if (failure) throw failure;
    if (method === "sendMessage") {
      return messageResult(Number(payload.chat_id), String(payload.text));
    }
    return true;
  };
  Object.assign(bot.context, {
    telegram: {
      sendMessage: async (
        chatId: number,
        text: string,
        extra: Record<string, unknown> = {},
      ) => await callApi("sendMessage", { chat_id: chatId, text, ...extra }),
      setMessageReaction: async (
        chatId: number,
        messageId: number,
        reaction: unknown,
        isBig: boolean | undefined,
      ) =>
        await callApi("setMessageReaction", {
          chat_id: chatId,
          message_id: messageId,
          reaction,
          is_big: isBig,
        }),
      answerCbQuery: async (
        callbackQueryId: string,
        text: string | undefined,
        extra: Record<string, unknown> = {},
      ) =>
        await callApi("answerCallbackQuery", {
          callback_query_id: callbackQueryId,
          text,
          ...extra,
        }),
    },
  });
  return { bot, calls };
}

function groupCommand(
  updateId: number,
  text: string,
  replyUser?: Record<string, unknown>,
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: -100123, type: "supergroup", title: "Builders" },
      from: {
        id: 456,
        is_bot: false,
        first_name: "Nominator",
        username: "nominator",
      },
      text,
      entities: [{ offset: 0, length: 8, type: "bot_command" }],
      ...(replyUser
        ? {
            reply_to_message: {
              message_id: updateId - 1,
              date: 1,
              chat: { id: -100123, type: "supergroup", title: "Builders" },
              from: replyUser,
              text: "hello",
            },
          }
        : {}),
    },
  };
}

function privateStart(
  updateId: number,
  userId: number,
  username: string,
  payload?: string,
) {
  const text = payload ? `/start ${payload}` : "/start";
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: userId, type: "private", first_name: "Alice", username },
      from: { id: userId, is_bot: false, first_name: "Alice", username },
      text,
      entities: [{ offset: 0, length: 6, type: "bot_command" }],
    },
  };
}

function sentMessages(calls: TelegramCall[]) {
  return calls.filter((call) => call.method === "sendMessage");
}

test("Telegram API connections use IPv4", () => {
  const bot = createBot("test-token", {
    nominations: {
      createNomination: async () => {
        throw new Error("not used");
      },
      claimNomination: async () => {
        throw new Error("not used");
      },
    },
  });

  const agent = bot.telegram.options.agent as unknown as {
    options: { family?: number };
  };
  assert.equal(agent.options.family, 4);
});

test("command menus are cleared sequentially", async () => {
  const scopes: string[] = [];
  let activeCalls = 0;
  const bot = {
    telegram: {
      setMyCommands: async (
        _commands: unknown[],
        options: { scope: { type: string } },
      ) => {
        activeCalls += 1;
        assert.equal(activeCalls, 1);
        scopes.push(options.scope.type);
        await Promise.resolve();
        activeCalls -= 1;
      },
    },
  };

  await clearCommandMenus(bot as never);

  assert.deepEqual(scopes, ["default", "all_group_chats", "all_private_chats"]);
});

test("username nominations stay provisional and use a nomination deep link", async () => {
  let createInput: unknown;
  const nominations: BotDependencies["nominations"] = {
    createNomination: async (input) => {
      createInput = input;
      return {
        nominationId: "nom_pending",
        status: "awaiting_claim",
        created: true,
      };
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(groupCommand(50, "/onboard @Alice") as never);

  assert.deepEqual(createInput, {
    source: "telegram",
    sourceNominationId: "50",
    nomineeTelegramId: null,
    nomineeUsername: "Alice",
    nominatedByTelegramId: 456,
    telegramGroupId: -100123,
  });
  assert.equal(
    calls.some((call) => call.method === "getChatMember"),
    false,
  );
  const groupReply = sentMessages(calls)[0];
  const keyboard = groupReply?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ url: string }>>;
  };
  const startUrl = new URL(keyboard.inline_keyboard[0]?.[0]?.url ?? "");
  assert.equal(startUrl.hostname, "t.me");
  assert.equal(startUrl.searchParams.get("start"), "nom_pending");
});

test("reply nominations send the stable website URL directly", async () => {
  let createInput: unknown;
  const nominations: BotDependencies["nominations"] = {
    createNomination: async (input) => {
      createInput = input;
      return {
        nominationId: "nom_reply",
        status: "awaiting_profile",
        joinUrl: "https://nearbuilders.org/join?nomination=stable",
        created: true,
      };
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    groupCommand(51, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  assert.deepEqual(createInput, {
    source: "telegram",
    sourceNominationId: "51",
    nomineeTelegramId: 123,
    nomineeUsername: "alice",
    nominatedByTelegramId: 456,
    telegramGroupId: -100123,
  });
  const directMessage = sentMessages(calls).find(
    (call) => call.payload.chat_id === 123,
  );
  const keyboard = directMessage?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
  assert.equal(
    keyboard.inline_keyboard[0]?.[0]?.text,
    "✅ I’ll complete my profile",
  );
  assert.equal(
    keyboard.inline_keyboard[0]?.[0]?.url,
    "https://nearbuilders.org/join?nomination=stable",
  );
  assert.match(
    String(
      sentMessages(calls).find((call) => call.payload.chat_id === -100123)
        ?.payload.text,
    ),
    /sent the onboarding link privately/,
  );
});

test("deep-link and plain start claims pass the verified Telegram identity", async () => {
  const claims: unknown[] = [];
  const results: Nomination[] = [
    {
      nominationId: "nom_deep",
      status: "awaiting_profile",
      joinUrl: "https://nearbuilders.org/join?nomination=deep",
      created: false,
    },
    { nominationId: "nom_plain", status: "under_review", created: false },
  ];
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async (input) => {
      claims.push(input);
      return results.shift()!;
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(privateStart(60, 123, "Alice", "nom_deep") as never);
  await bot.handleUpdate(privateStart(61, 123, "Alice") as never);

  assert.deepEqual(claims, [
    {
      nominationId: "nom_deep",
      nomineeTelegramId: 123,
      nomineeUsername: "Alice",
    },
    { nomineeTelegramId: 123, nomineeUsername: "Alice" },
  ]);
  const direct = sentMessages(calls).find((call) =>
    String(call.payload.text).includes("secure NEAR Builders link"),
  );
  const keyboard = direct?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ url: string }>>;
  };
  assert.equal(
    keyboard.inline_keyboard[0]?.[0]?.url,
    "https://nearbuilders.org/join?nomination=deep",
  );
  assert.match(
    String(sentMessages(calls).at(-1)?.payload.text),
    /under review/,
  );
});

test("only expected direct-message restrictions receive the Start Chat fallback", async () => {
  const nomination = {
    nominationId: "nom_restricted",
    status: "awaiting_profile",
    joinUrl: "https://nearbuilders.org/join?nomination=restricted",
    created: true,
  } as const;
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => nomination,
    claimNomination: async () => nomination,
  };
  const expectedError = new TelegramError({
    error_code: 403,
    description: "Forbidden: bot can't initiate conversation with a user",
  });
  const expected = setupBot(nominations, (method, payload) =>
    method === "sendMessage" && payload.chat_id === 123
      ? expectedError
      : undefined,
  );

  await expected.bot.handleUpdate(
    groupCommand(70, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  const expectedReply = sentMessages(expected.calls).find(
    (call) => call.payload.chat_id === -100123,
  );
  assert.match(
    String(expectedReply?.payload.text),
    /must start a private chat/,
  );
  assert.ok(expectedReply?.payload.reply_markup);

  const unexpected = setupBot(nominations, (method, payload) =>
    method === "sendMessage" && payload.chat_id === 123
      ? new Error("Telegram transport failed")
      : undefined,
  );
  await unexpected.bot.handleUpdate(
    groupCommand(71, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  const unexpectedReply = sentMessages(unexpected.calls).find(
    (call) => call.payload.chat_id === -100123,
  );
  assert.match(String(unexpectedReply?.payload.text), /couldn’t deliver/);
  assert.equal(unexpectedReply?.payload.reply_markup, undefined);
});

test("repeated nominations report authoritative lifecycle state without a handoff", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => ({
      nominationId: "nom_review",
      status: "under_review",
      created: false,
    }),
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    groupCommand(80, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  assert.equal(
    sentMessages(calls).some((call) => call.payload.chat_id === 123),
    false,
  );
  const groupReply = sentMessages(calls).find(
    (call) => call.payload.chat_id === -100123,
  );
  assert.match(String(groupReply?.payload.text), /already under review/);
  assert.equal(groupReply?.payload.reply_markup, undefined);
});

test("API failures never produce a nomination success or direct message", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("website unavailable");
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    groupCommand(85, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  assert.equal(
    sentMessages(calls).some((call) => call.payload.chat_id === 123),
    false,
  );
  const groupReply = sentMessages(calls).find(
    (call) => call.payload.chat_id === -100123,
  );
  assert.match(
    String(groupReply?.payload.text),
    /couldn’t save this nomination/,
  );
  assert.doesNotMatch(String(groupReply?.payload.text), /has been nominated/);
});

test("legacy callbacks receive the migration message", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);
  await bot.handleUpdate({
    update_id: 90,
    callback_query: {
      id: "callback-1",
      from: { id: 123, is_bot: false, first_name: "Alice", username: "alice" },
      chat_instance: "chat-instance",
      data: "confirm_nomination",
      message: {
        message_id: 89,
        date: 1,
        chat: { id: 123, type: "private", first_name: "Alice" },
        text: "old confirmation",
      },
    },
  } as never);

  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  assert.match(String(answer?.payload.text), /flow has retired/);
  assert.equal(answer?.payload.show_alert, true);
});
