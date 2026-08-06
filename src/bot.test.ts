import assert from "node:assert/strict";
import test from "node:test";
import { TelegramError } from "telegraf";
import { clearCommandMenus, createBot, type BotDependencies } from "./bot.js";
import { NominationApiError, type Nomination } from "./nomination-api.js";

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

test("un-nominated /start keeps the v1 response", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async () => {
      throw new NominationApiError("not found", 404);
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(privateStart(45, 123, "Alice") as never);

  assert.equal(
    sentMessages(calls)[0]?.payload.text,
    "👋 Welcome to the <b>NEAR Builders</b> onboarding bot!\n\n" +
      "You will need to be nominated to enter the bot!",
  );
});

test("invalid group nomination keeps the v1 response", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(groupCommand(46, "/onboard") as never);

  assert.equal(
    sentMessages(calls)[0]?.payload.text,
    "⚠️ Use this command as a <b>reply</b> to someone, or with a username:\n" +
      "<code>/onboard @username</code>",
  );
});

test("bot targets keep the v1 rejection response", async () => {
  let created = false;
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      created = true;
      throw new Error("not used");
    },
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    groupCommand(47, "/onboard", {
      id: 999,
      is_bot: true,
      first_name: "Bot",
    }) as never,
  );

  assert.equal(created, false);
  assert.equal(sentMessages(calls)[0]?.payload.text, "🤖 You can't nominate a bot!");
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
  assert.equal(
    groupReply?.payload.text,
    "👋 @Alice, you've been nominated as a NEAR Builder by " +
      '<a href="tg://user?id=456">Nominator</a>!\n\n' +
      "To complete your profile, please start a chat with me first by clicking the button below.",
  );
  const keyboard = groupReply?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
  const startUrl = new URL(keyboard.inline_keyboard[0]?.[0]?.url ?? "");
  assert.equal(startUrl.hostname, "t.me");
  assert.equal(startUrl.searchParams.get("start"), "nom_pending");
  assert.equal(keyboard.inline_keyboard[0]?.[0]?.text, "💬 Start Chat");
});

test("username nominations with an existing website handoff still provide a deep link", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => ({
      nominationId: "nom_profile",
      status: "awaiting_profile",
      joinUrl: "https://nearbuilders.org/join?nomination=existing",
      created: false,
    }),
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(groupCommand(50, "/onboard @Alice") as never);

  const groupReply = sentMessages(calls)[0];
  assert.match(String(groupReply?.payload.text), /please start a chat with me/);
  const keyboard = groupReply?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ url: string }>>;
  };
  const startUrl = new URL(keyboard.inline_keyboard[0]?.[0]?.url ?? "");
  assert.equal(startUrl.searchParams.get("start"), "nom_profile");
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
  assert.equal(
    directMessage?.payload.text,
    "🎉 You've been nominated as a NEAR Builder by " +
      '<a href="tg://user?id=456">Nominator</a>!\n\n' +
      "Complete your profile using the secure website link below.",
  );
  assert.equal(
    sentMessages(calls).some((call) => call.payload.chat_id === -100123),
    false,
  );
});

test("reused direct nominations keep the v1 nominator message", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => ({
      nominationId: "nom_existing",
      status: "awaiting_profile",
      joinUrl: "https://nearbuilders.org/join?nomination=existing",
      created: false,
    }),
    claimNomination: async () => {
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    groupCommand(52, "/onboard", {
      id: 123,
      is_bot: false,
      first_name: "Alice",
      username: "alice",
    }) as never,
  );

  const directMessage = sentMessages(calls).find(
    (call) => call.payload.chat_id === 123,
  );
  assert.equal(
    directMessage?.payload.text,
    "🎉 You've been nominated as a NEAR Builder by " +
      '<a href="tg://user?id=456">Nominator</a>!\n\n' +
      "Complete your profile using the secure website link below.",
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
  assert.equal(
    direct?.payload.text,
    "✅ You've been nominated! Let's set up your builder profile.\n\n" +
      "Complete your builder profile using the secure NEAR Builders link below.",
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
    /already submitted your builder profile/,
  );
});

test("invalid start payloads are rejected before the API call", async () => {
  let claimed = false;
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async () => {
      claimed = true;
      throw new Error("not used");
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    privateStart(63, 123, "Alice", "bad.payload") as never,
  );

  assert.equal(claimed, false);
  assert.equal(
    sentMessages(calls)[0]?.payload.text,
    "⚠️ This nomination link is invalid. Ask for a new /onboard nomination.",
  );
});

test("start rejects a nomination claimed by a different Telegram identity", async () => {
  const nominations: BotDependencies["nominations"] = {
    createNomination: async () => {
      throw new Error("not used");
    },
    claimNomination: async () => {
      throw new NominationApiError("identity mismatch", 403);
    },
  };
  const { bot, calls } = setupBot(nominations);

  await bot.handleUpdate(
    privateStart(64, 123, "Alice", "nom_other") as never,
  );

  assert.equal(
    sentMessages(calls)[0]?.payload.text,
    "⚠️ This nomination does not match your Telegram account or current username. Ask for a new nomination.",
  );
});

for (const [status, expectedText] of [
  ["processing", "⏳ Your builder application is being processed."],
  ["accepted", "🎉 You’ve been accepted as a NEAR Builder."],
  [
    "rejected",
    "ℹ️ Your builder application was not accepted. Any new submission should use the website.",
  ],
  [
    "removed",
    "ℹ️ Your builder profile has been removed. Any new submission should use the website.",
  ],
  [
    "processing_failed",
    "⚠️ Your builder application could not be processed. An administrator can retry it.",
  ],
] as const) {
  test(`/start relays the v2 ${status} lifecycle response`, async () => {
    const nominations: BotDependencies["nominations"] = {
      createNomination: async () => {
        throw new Error("not used");
      },
      claimNomination: async () =>
        ({
          nominationId: `nom_${status}`,
          status,
          created: false,
        }) as Nomination,
    };
    const { bot, calls } = setupBot(nominations);

    await bot.handleUpdate(privateStart(62, 123, "Alice") as never);

    assert.equal(sentMessages(calls)[0]?.payload.text, expectedText);
  });
}

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
    /couldn't send them a DM/,
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

test("under-review nominations preserve the v1 completed reaction behavior", async () => {
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
  assert.equal(
    sentMessages(calls).some((call) => call.payload.chat_id === -100123),
    false,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === "setMessageReaction" &&
        JSON.stringify(call.payload.reaction).includes("🎉"),
    ),
  );
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
