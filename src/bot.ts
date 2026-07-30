import { Markup, Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { User } from "telegraf/types";
import { acknowledgeCallbackQuery } from "./callback-query.js";
import { config } from "./config.js";
import * as defaultDb from "./db.js";
import { logger } from "./logger.js";
import {
  createNomination as createNominationDefault,
  type NominationHandoff,
} from "./nomination-api.js";

type HandlerDatabase = Pick<
  typeof defaultDb,
  | "hasStartedBot"
  | "claimPendingNomination"
  | "registerUser"
  | "hasCompleted"
  | "hasConfirmed"
  | "getUserByUsername"
  | "addPendingNomination"
  | "logNomination"
  | "getNomination"
  | "confirmNomination"
>;

export interface BotDependencies {
  db: HandlerDatabase;
  createNomination: typeof createNominationDefault;
}

const productionDependencies: BotDependencies = {
  db: defaultDb,
  createNomination: createNominationDefault,
};

interface NominationTarget {
  id: number | null;
  username: string | null;
  firstName: string;
  isBot: boolean;
}

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mentionUser(user: Pick<User, "id" | "first_name">): string {
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name)}</a>`;
}

function mentionUserId(userId: number, label: string): string {
  return `<a href="tg://user?id=${userId}">${escapeHtml(label)}</a>`;
}

function mentionTarget(target: NominationTarget): string {
  if (target.id !== null) {
    return mentionUserId(target.id, target.firstName);
  }
  return `@${escapeHtml(target.username ?? target.firstName)}`;
}

function buildStartKeyboard(ctx: Context) {
  const username = config.botUsername || ctx.botInfo.username;
  return Markup.inlineKeyboard([
    [Markup.button.url("💬 Start Chat", `https://t.me/${username}`)],
  ]);
}

function buildConfirmationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ I’ll complete my profile",
        "confirm_nomination",
      ),
    ],
  ]);
}

function buildJoinKeyboard(joinUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url("🌐 Continue on NEAR Builders", joinUrl)],
  ]);
}

async function replyToGroupCommand(
  ctx: Context,
  text: string,
  extra: Parameters<Context["reply"]>[1] = {},
): Promise<void> {
  if (!ctx.message) return;
  await ctx.reply(text, {
    ...extra,
    reply_parameters: { message_id: ctx.message.message_id },
  });
}

async function issueHandoff(
  user: User,
  dependencies: BotDependencies,
): Promise<NominationHandoff> {
  const nomination = await dependencies.db.getNomination(user.id);
  if (!nomination) {
    throw new Error("No nomination found for this Telegram user");
  }

  const handoff = await dependencies.createNomination({
    source: "telegram",
    sourceNominationId: String(nomination.id),
    nomineeTelegramId: user.id,
    nomineeUsername: user.username ?? null,
    nominatedByTelegramId: nomination.nominated_by_user_id,
    telegramGroupId: nomination.group_chat_id,
  });
  await dependencies.db.confirmNomination({
    nominationId: nomination.id,
    nominatedUserId: user.id,
    websiteNominationId: handoff.nominationId,
  });
  return handoff;
}

async function sendConfirmationPrompt(
  ctx: Context,
  userId: number,
): Promise<void> {
  await ctx.telegram.sendMessage(
    userId,
    "🎉 <b>You’ve been nominated as a NEAR Builder!</b>\n\n" +
      "Confirm that you’re ready to onboard. After you confirm, I’ll send " +
      "you a secure link to complete your builder profile on the NEAR " +
      "Builders website.",
    {
      parse_mode: "HTML",
      ...buildConfirmationKeyboard(),
    },
  );
}

async function sendExistingHandoff(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!ctx.from) return;
  try {
    const handoff = await issueHandoff(ctx.from, dependencies);
    await ctx.reply(
      "✅ You’ve already confirmed your nomination.\n\n" +
        "Continue your onboarding using the secure link provided by the " +
        "NEAR Builders website.",
      buildJoinKeyboard(handoff.joinUrl),
    );
  } catch (error) {
    logger.error(
      { err: error, userId: ctx.from.id },
      "Could not refresh nomination handoff",
    );
    await ctx.reply(
      "❌ I couldn’t create your secure onboarding link. Please try again shortly.",
    );
  }
}

async function handleStart(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return;
  const user = ctx.from;
  const { db } = dependencies;

  if (user.username && !(await db.hasStartedBot(user.id))) {
    const pending = await db.claimPendingNomination(user.id, user.username);
    if (pending) {
      logger.info(
        { username: user.username, userId: user.id },
        "Claimed pending nomination",
      );
      await db.registerUser(user.id, user.username, user.first_name);
    }
  }

  if (!(await db.hasStartedBot(user.id))) {
    await ctx.reply(
      "👋 Welcome to the <b>NEAR Builders</b> nomination bot!\n\n" +
        "You need to be nominated by a community member before you can onboard.",
      { parse_mode: "HTML" },
    );
    return;
  }

  await db.registerUser(user.id, user.username, user.first_name);

  if (await db.hasCompleted(user.id)) {
    await ctx.reply(
      "✅ Your builder profile has already been submitted.\n\n" +
        "Welcome to the NEAR Builders community! 🌿",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (await db.hasConfirmed(user.id)) {
    await sendExistingHandoff(ctx, dependencies);
    return;
  }

  await sendConfirmationPrompt(ctx, user.id);
}

async function resolveTarget(
  ctx: Context,
  username: string,
  dependencies: BotDependencies,
): Promise<NominationTarget> {
  const dbUser = await dependencies.db.getUserByUsername(username);
  if (dbUser) {
    logger.info(
      { username, userId: dbUser.user_id },
      "Username resolved from database",
    );
    return {
      id: dbUser.user_id,
      username: dbUser.username,
      firstName: dbUser.first_name ?? dbUser.username ?? username,
      isBot: false,
    };
  }

  try {
    // Telegram's types require a numeric ID, but the API accepts a username
    // here as a best-effort lookup before falling back to a pending claim.
    const member = await ctx.telegram.callApi("getChatMember", {
      chat_id: ctx.chat!.id,
      user_id: `@${username}` as unknown as number,
    });
    return {
      id: member.user.id,
      username: member.user.username ?? username,
      firstName: member.user.first_name,
      isBot: member.user.is_bot,
    };
  } catch (error) {
    logger.info(
      { username, err: error },
      "Username unresolved; storing a pending nomination",
    );
    return {
      id: null,
      username,
      firstName: username,
      isBot: false,
    };
  }
}

async function handleNominate(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isGroup(ctx) || !ctx.from || !ctx.message || !("text" in ctx.message)) {
    return;
  }

  const invoker = ctx.from;
  const argument = ctx.message.text.split(/\s+/)[1];
  let target: NominationTarget | null = null;

  if (argument) {
    const username = argument.replace(/^@/, "");
    if (username) target = await resolveTarget(ctx, username, dependencies);
  } else if (
    ctx.message.reply_to_message &&
    ctx.message.reply_to_message.from
  ) {
    const replyUser = ctx.message.reply_to_message.from;
    target = {
      id: replyUser.id,
      username: replyUser.username ?? null,
      firstName: replyUser.first_name,
      isBot: replyUser.is_bot,
    };
  }

  if (!target) {
    await replyToGroupCommand(
      ctx,
      "⚠️ Reply to someone with this command, or provide a username:\n" +
        "<code>/onboard @username</code>",
      { parse_mode: "HTML" },
    );
    return;
  }
  if (target.isBot) {
    await replyToGroupCommand(ctx, "🤖 You can’t nominate a bot.");
    return;
  }

  const targetMention = mentionTarget(target);
  const invokerMention = mentionUser(invoker);
  const { db } = dependencies;

  if (target.id === null) {
    const username = target.username;
    if (!username) return;
    await db.addPendingNomination(username, invoker.id, ctx.chat!.id);
    await db.logNomination({
      nominatedByUserId: invoker.id,
      groupChatId: ctx.chat!.id,
      nominatedUsername: username,
    });
    await replyToGroupCommand(
      ctx,
      `👋 ${targetMention}, you’ve been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
        "Start a private chat with me to confirm your nomination and receive your secure website onboarding link.",
      {
        parse_mode: "HTML",
        ...buildStartKeyboard(ctx),
      },
    );
    return;
  }

  const alreadyStarted = await db.hasStartedBot(target.id);
  const alreadyConfirmed = alreadyStarted
    ? await db.hasConfirmed(target.id)
    : false;
  if (alreadyConfirmed) {
    try {
      await ctx.react("🎉");
    } catch (error) {
      logger.warn({ err: error }, "Could not set confirmed reaction");
    }
    return;
  }

  await db.registerUser(
    target.id,
    target.username ?? undefined,
    target.firstName,
  );
  await db.logNomination({
    nominatedUserId: target.id,
    nominatedByUserId: invoker.id,
    groupChatId: ctx.chat!.id,
    ...(target.username ? { nominatedUsername: target.username } : {}),
  });

  if (alreadyStarted) {
    try {
      await ctx.telegram.sendMessage(
        target.id,
        `🎉 You’ve been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
          "Confirm that you’re ready to onboard, and I’ll send you a secure link to complete your profile on the NEAR Builders website.",
        {
          parse_mode: "HTML",
          ...buildConfirmationKeyboard(),
        },
      );
      try {
        await ctx.react("👀");
      } catch (error) {
        logger.warn({ err: error }, "Could not set pending reaction");
      }
    } catch (error) {
      logger.warn({ userId: target.id, err: error }, "Failed to DM nominee");
      await replyToGroupCommand(
        ctx,
        `⚠️ ${targetMention} has been nominated, but I couldn’t send them a DM. ` +
          "Please start a chat with me using the button below.",
        {
          parse_mode: "HTML",
          ...buildStartKeyboard(ctx),
        },
      );
    }
    return;
  }

  try {
    await ctx.react("👀");
  } catch (error) {
    logger.warn({ err: error }, "Could not set pending reaction");
  }
  await replyToGroupCommand(
    ctx,
    `👋 ${targetMention}, you’ve been nominated as a NEAR Builder by ${invokerMention}!\n\n` +
      "Start a private chat with me to confirm your nomination and receive your secure website onboarding link.",
    {
      parse_mode: "HTML",
      ...buildStartKeyboard(ctx),
    },
  );
}

function callbackData(ctx: Context): string | null {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return null;
  return ctx.callbackQuery.data;
}

async function handleDmMessage(ctx: Context): Promise<void> {
  if (!isPrivate(ctx) || !ctx.message || !("text" in ctx.message)) return;
  if (ctx.message.text.startsWith("/")) return;
  await ctx.reply(
    "Profile onboarding now happens on the NEAR Builders website. " +
      "Use /start to confirm your nomination and get a secure join link.",
  );
}

async function handleCallback(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!ctx.from) return;
  const data = callbackData(ctx);
  if (!data) return;
  if (data !== "confirm_nomination") {
    await acknowledgeCallbackQuery(() =>
      ctx.answerCbQuery(
        "This onboarding flow has moved to the website. Send /start for a new secure link.",
        { show_alert: true },
      ),
    );
    return;
  }
  const acknowledged = await acknowledgeCallbackQuery(() =>
    ctx.answerCbQuery(),
  );
  if (!acknowledged) return;

  try {
    const handoff = await issueHandoff(ctx.from, dependencies);
    await ctx.editMessageText(
      "✅ <b>Nomination confirmed!</b>\n\n" +
        "Complete your builder profile using the secure link provided by " +
        "the NEAR Builders website.",
      {
        parse_mode: "HTML",
        ...buildJoinKeyboard(handoff.joinUrl),
      },
    );
  } catch (error) {
    logger.error(
      { err: error, userId: ctx.from.id },
      "Could not create nomination handoff",
    );
    await ctx.reply(
      "❌ I couldn’t create your secure onboarding link. Please try again shortly.",
    );
  }
}

export async function clearCommandMenus(bot: Telegraf): Promise<void> {
  await Promise.all([
    bot.telegram.setMyCommands([], { scope: { type: "default" } }),
    bot.telegram.setMyCommands([], {
      scope: { type: "all_group_chats" },
    }),
    bot.telegram.setMyCommands([], {
      scope: { type: "all_private_chats" },
    }),
  ]);
  logger.info("Bot command menus cleared");
}

export function createBot(
  token: string,
  dependencies: BotDependencies = productionDependencies,
): Telegraf {
  const bot = new Telegraf(token);
  bot.start((ctx) => handleStart(ctx, dependencies));
  bot.command("onboard", (ctx) => handleNominate(ctx, dependencies));
  bot.on(message("text"), handleDmMessage);
  bot.on("callback_query", (ctx) => handleCallback(ctx, dependencies));
  bot.catch((error, ctx) => {
    logger.error(
      { err: error, updateId: ctx.update.update_id },
      "Unhandled bot update error",
    );
  });
  return bot;
}
