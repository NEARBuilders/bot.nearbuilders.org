import { Agent as HttpsAgent } from "node:https";
import { Markup, Telegraf, TelegramError, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { User } from "telegraf/types";
import { acknowledgeCallbackQuery } from "./callback-query.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  NominationApiError,
  nominationApi as defaultNominationApi,
  type Nomination,
} from "./nomination-api.js";

export interface BotDependencies {
  nominations: Pick<
    typeof defaultNominationApi,
    "createNomination" | "claimNomination"
  >;
}

const productionDependencies: BotDependencies = {
  nominations: defaultNominationApi,
};

const telegramAgent = new HttpsAgent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 10_000,
});

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
  if (target.id !== null) return mentionUserId(target.id, target.firstName);
  return `@${escapeHtml(target.username ?? target.firstName)}`;
}

function botUsername(ctx: Context): string {
  return config.botUsername || ctx.botInfo.username;
}

function buildStartKeyboard(ctx: Context, nominationId: string) {
  const startUrl = new URL(`https://t.me/${botUsername(ctx)}`);
  startUrl.searchParams.set("start", nominationId);
  return Markup.inlineKeyboard([
    [Markup.button.url("💬 Start Chat", startUrl.toString())],
  ]);
}

function buildJoinKeyboard(joinUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url("✅ I’ll complete my profile", joinUrl)],
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

function isExpectedDirectMessageRestriction(error: unknown): boolean {
  if (
    !(error instanceof TelegramError) ||
    (error.code !== 400 && error.code !== 403)
  ) {
    return false;
  }
  const description = error.description.toLowerCase();
  return [
    "bot can't initiate conversation",
    "bot was blocked",
    "chat not found",
    "user is deactivated",
  ].some((message) => description.includes(message));
}

async function reactCosmetically(
  ctx: Context,
  emoji: "👀" | "🎉",
): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch (error) {
    logger.warn(
      {
        err: error,
        emoji,
        updateId: ctx.update.update_id,
        chatId: ctx.chat?.id,
      },
      "Could not set nomination reaction",
    );
  }
}

function lifecycleMessage(
  status: Nomination["status"],
  subject: string,
): string {
  switch (status) {
    case "awaiting_claim":
      return `👋 ${subject} has been nominated and needs to start a private chat with me.`;
    case "awaiting_profile":
      return `✅ ${subject} has already been nominated. I’ll resend the existing onboarding handoff.`;
    case "under_review":
      return `🔎 ${subject}’s builder profile is already under review.`;
    case "processing":
      return `⏳ ${subject}’s builder application is being processed.`;
    case "accepted":
      return `🎉 ${subject} has already been accepted as a NEAR Builder.`;
    case "rejected":
      return `ℹ️ ${subject}’s builder application was not accepted. Any new submission should use the website.`;
    case "removed":
      return `ℹ️ ${subject}’s builder profile has been removed. Any new submission should use the website.`;
    case "processing_failed":
      return `⚠️ ${subject}’s builder application could not be processed. An administrator can retry it.`;
  }
}

async function sendPrivateNominationStatus(
  ctx: Context,
  nomination: Nomination,
): Promise<void> {
  if (nomination.status === "awaiting_profile") {
    await ctx.reply(
      "🎉 <b>You’ve been nominated as a NEAR Builder!</b>\n\n" +
        "Complete your builder profile using your secure NEAR Builders link.",
      { parse_mode: "HTML", ...buildJoinKeyboard(nomination.joinUrl) },
    );
    return;
  }

  const messages: Record<
    Exclude<Nomination["status"], "awaiting_profile">,
    string
  > = {
    awaiting_claim:
      "⚠️ Your Telegram identity still needs verification. Reopen the nomination link.",
    under_review: "🔎 Your builder profile is under review.",
    processing: "⏳ Your builder application is being processed.",
    accepted: "🎉 You’ve been accepted as a NEAR Builder.",
    rejected:
      "ℹ️ Your builder application was not accepted. Any new submission should use the website.",
    removed:
      "ℹ️ Your builder profile has been removed. Any new submission should use the website.",
    processing_failed:
      "⚠️ Your builder application could not be processed. An administrator can retry it.",
  };
  await ctx.reply(messages[nomination.status]);
}

async function handleStart(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return;
  const startPayload =
    ctx.message && "text" in ctx.message
      ? ctx.message.text.trim().split(/\s+/, 2)[1]?.trim()
      : undefined;
  if (startPayload && !/^[A-Za-z0-9_-]{1,64}$/.test(startPayload)) {
    await ctx.reply(
      "⚠️ This nomination link is invalid. Ask for a new /onboard nomination.",
    );
    return;
  }

  try {
    const nomination = await dependencies.nominations.claimNomination({
      ...(startPayload ? { nominationId: startPayload } : {}),
      nomineeTelegramId: ctx.from.id,
      nomineeUsername: ctx.from.username ?? null,
    });
    await sendPrivateNominationStatus(ctx, nomination);
  } catch (error) {
    if (error instanceof NominationApiError && error.status === 404) {
      await ctx.reply(
        "👋 Welcome to the NEAR Builders nomination bot. You need a nomination before you can onboard.",
      );
      return;
    }
    if (error instanceof NominationApiError && error.status === 403) {
      await ctx.reply(
        "⚠️ This nomination does not match your Telegram account or current username. Ask for a new nomination.",
      );
      return;
    }
    logger.error(
      {
        err: error,
        userId: ctx.from.id,
        nominationId: startPayload,
        updateId: ctx.update.update_id,
      },
      "Could not recover Telegram nomination",
    );
    await ctx.reply(
      "❌ I couldn’t load your nomination. Please try again shortly.",
    );
  }
}

function resolveTarget(ctx: Context): NominationTarget | null {
  if (!ctx.message || !("text" in ctx.message)) return null;
  const argument = ctx.message.text.split(/\s+/)[1];
  if (argument) {
    const username = argument.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,32}$/.test(username)) return null;
    return { id: null, username, firstName: username, isBot: false };
  }
  const replyUser = ctx.message.reply_to_message?.from;
  if (!replyUser) return null;
  return {
    id: replyUser.id,
    username: replyUser.username ?? null,
    firstName: replyUser.first_name,
    isBot: replyUser.is_bot,
  };
}

async function sendNomineeHandoff(
  ctx: Context,
  target: NominationTarget & { id: number },
  nomination: Extract<Nomination, { status: "awaiting_profile" }>,
): Promise<"sent" | "restricted" | "failed"> {
  try {
    await ctx.telegram.sendMessage(
      target.id,
      nomination.created
        ? "🎉 <b>You’ve been nominated as a NEAR Builder!</b>\n\nComplete your profile using the secure website link below."
        : "✅ <b>You’ve already been nominated.</b>\n\nHere is your existing secure website onboarding link.",
      { parse_mode: "HTML", ...buildJoinKeyboard(nomination.joinUrl) },
    );
    return "sent";
  } catch (error) {
    if (isExpectedDirectMessageRestriction(error)) {
      logger.info(
        { userId: target.id, updateId: ctx.update.update_id },
        "Nominee must start the Telegram chat before receiving a direct message",
      );
      return "restricted";
    }
    logger.error(
      { err: error, userId: target.id, updateId: ctx.update.update_id },
      "Unexpected Telegram failure while sending nomination handoff",
    );
    return "failed";
  }
}

async function handleNominate(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isGroup(ctx) || !ctx.from || !ctx.message || !("text" in ctx.message))
    return;
  const groupChatId = ctx.chat?.id;
  if (typeof groupChatId !== "number") return;
  const target = resolveTarget(ctx);
  if (!target) {
    await replyToGroupCommand(
      ctx,
      "⚠️ Reply to someone with this command, or provide a valid username:\n" +
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
  const invokerMention = mentionUser(ctx.from);
  let nomination: Nomination;
  try {
    nomination = await dependencies.nominations.createNomination({
      source: "telegram",
      sourceNominationId: String(ctx.update.update_id),
      nomineeTelegramId: target.id,
      nomineeUsername: target.username,
      nominatedByTelegramId: ctx.from.id,
      telegramGroupId: groupChatId,
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        updateId: ctx.update.update_id,
        chatId: groupChatId,
        nomineeTelegramId: target.id,
        nomineeUsername: target.username,
      },
      "Could not create Telegram nomination",
    );
    await replyToGroupCommand(
      ctx,
      "❌ I couldn’t save this nomination. Please try again shortly.",
    );
    return;
  }

  if (nomination.status === "awaiting_claim") {
    await replyToGroupCommand(
      ctx,
      nomination.created
        ? `👋 ${targetMention}, you’ve been nominated as a NEAR Builder by ${invokerMention}!\n\nStart a private chat with me to continue.`
        : `✅ ${targetMention} has already been nominated. Use the existing private-chat handoff below.`,
      {
        parse_mode: "HTML",
        ...buildStartKeyboard(ctx, nomination.nominationId),
      },
    );
    await reactCosmetically(ctx, "👀");
    return;
  }

  if (nomination.status === "awaiting_profile" && target.id !== null) {
    const delivery = await sendNomineeHandoff(
      ctx,
      { ...target, id: target.id },
      nomination,
    );
    if (delivery === "sent") {
      await replyToGroupCommand(
        ctx,
        nomination.created
          ? `✅ ${targetMention} has been nominated by ${invokerMention}. I sent the onboarding link privately.`
          : `✅ ${targetMention} was already nominated. I resent the existing onboarding link privately.`,
        { parse_mode: "HTML" },
      );
      await reactCosmetically(ctx, "👀");
      return;
    }
    if (delivery === "restricted") {
      await replyToGroupCommand(
        ctx,
        `⚠️ ${targetMention} has been nominated, but must start a private chat before I can send the onboarding link.`,
        {
          parse_mode: "HTML",
          ...buildStartKeyboard(ctx, nomination.nominationId),
        },
      );
      await reactCosmetically(ctx, "👀");
      return;
    }
    await replyToGroupCommand(
      ctx,
      `❌ The nomination was saved, but I couldn’t deliver ${targetMention}’s onboarding link. Please try again shortly.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await replyToGroupCommand(
    ctx,
    lifecycleMessage(nomination.status, targetMention),
    {
      parse_mode: "HTML",
    },
  );
  if (nomination.status === "accepted") await reactCosmetically(ctx, "🎉");
}

async function handleDmMessage(ctx: Context): Promise<void> {
  if (!isPrivate(ctx) || !ctx.message || !("text" in ctx.message)) return;
  if (ctx.message.text.startsWith("/")) return;
  await ctx.reply(
    "Profile onboarding happens on the NEAR Builders website. Send /start to recover your nomination and secure link.",
  );
}

async function handleCallback(ctx: Context): Promise<void> {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
  await acknowledgeCallbackQuery(() =>
    ctx.answerCbQuery(
      "This bot-side onboarding flow has retired. Send /start to recover your website handoff.",
      { show_alert: true },
    ),
  );
}

export async function clearCommandMenus(bot: Telegraf): Promise<void> {
  await bot.telegram.setMyCommands([], { scope: { type: "default" } });
  await bot.telegram.setMyCommands([], { scope: { type: "all_group_chats" } });
  await bot.telegram.setMyCommands([], {
    scope: { type: "all_private_chats" },
  });
  logger.info("Bot command menus cleared");
}

export function createBot(
  token: string,
  dependencies: BotDependencies = productionDependencies,
): Telegraf {
  const bot = new Telegraf(token, { telegram: { agent: telegramAgent } });
  bot.start((ctx) => handleStart(ctx, dependencies));
  bot.command("onboard", (ctx) => handleNominate(ctx, dependencies));
  bot.on(message("text"), handleDmMessage);
  bot.on("callback_query", handleCallback);
  bot.catch(async (error, ctx) => {
    logger.error(
      {
        err: error,
        updateId: ctx.update.update_id,
        chatId: ctx.chat?.id,
        userId: ctx.from?.id,
      },
      "Unhandled bot update error",
    );
    try {
      await ctx.reply(
        "❌ Something went wrong while handling that request. Please try again shortly.",
      );
    } catch (replyError) {
      logger.error(
        { err: replyError, updateId: ctx.update.update_id },
        "Could not send last-resort Telegram failure response",
      );
    }
  });
  return bot;
}
