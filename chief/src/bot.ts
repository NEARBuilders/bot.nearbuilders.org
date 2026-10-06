import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "./config.js";
import { escapeHtml, formatDigestMessage } from "./digest-message.js";
import { logEvent } from "./logger.js";
import { digestKeyboard } from "./review-actions.js";
import {
  ReviewDecisionError,
  submitReviewDecision,
  type ReviewDecisionInput,
  type ReviewDecisionResult,
} from "./review-decision-api.js";
import { fetchReviewDigest, type ReviewDigest } from "./review-digest-api.js";
import { createReviewFlow } from "./review-flow.js";
import {
  claimTelegramLink,
  type TelegramLinkClaim,
  type TelegramLinkResult,
} from "./review-link-api.js";
import { telegramAgent } from "./telegram-agent.js";

export interface BotDependencies {
  reviewDigest?: () => Promise<ReviewDigest>;
  adminChatId?: string;
  decideReview?: (input: ReviewDecisionInput) => Promise<ReviewDecisionResult>;
  claimTelegramLink?: (input: TelegramLinkClaim) => Promise<TelegramLinkResult>;
}

const productionDependencies: BotDependencies = {
  reviewDigest: () => fetchReviewDigest({ retryDelaysMs: [] }),
  adminChatId: config.adminChatId,
  decideReview: (input) => submitReviewDecision(input),
  claimTelegramLink: (input) => claimTelegramLink(input),
};

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

function isAdminChat(ctx: Context, dependencies: BotDependencies): boolean {
  return (
    Boolean(dependencies.adminChatId) &&
    String(ctx.chat?.id) === dependencies.adminChatId
  );
}

async function handlePending(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isAdminChat(ctx, dependencies) || !dependencies.reviewDigest) {
    logEvent("info", "pending.ignored", {
      chatId: ctx.chat?.id,
      outcome: "not_admin_chat",
    });
    return;
  }
  let digest: ReviewDigest;
  try {
    digest = await dependencies.reviewDigest();
  } catch (error) {
    logEvent("error", "pending.fetch_failed", { err: error });
    await ctx.reply(
      "⚠️ Couldn’t load the review queue right now. Check the review dashboard directly.",
    );
    return;
  }
  const message = formatDigestMessage(digest, { siteUrl: config.nearBuildersSiteUrl });
  if (!message) {
    await ctx.reply("✅ Nothing is waiting for review.");
    logEvent("info", "pending.replied", { pending: 0 });
    return;
  }
  await ctx.reply(message.text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...digestKeyboard(message),
  });
  logEvent("info", "pending.replied", { pending: digest.totals.pending });
}

async function handleOwnPinNotice(
  ctx: Context,
  dependencies: BotDependencies,
): Promise<void> {
  if (!isAdminChat(ctx, dependencies) || ctx.from?.id !== ctx.botInfo.id) {
    return;
  }
  try {
    await ctx.deleteMessage();
    logEvent("info", "digest.pin_notice_deleted");
  } catch (error) {
    logEvent("warn", "digest.pin_notice_delete_failed", { err: error });
  }
}

const ADMIN_GROUP_STATUSES = new Set(["creator", "administrator", "member"]);

async function isAdminGroupMember(
  ctx: Context,
  adminChatId: string,
  userId: number,
): Promise<boolean> {
  try {
    const member = await ctx.telegram.getChatMember(adminChatId, userId);
    return (
      ADMIN_GROUP_STATUSES.has(member.status) ||
      (member.status === "restricted" && member.is_member)
    );
  } catch (error) {
    logEvent("warn", "link.membership_check_failed", { err: error });
    return false;
  }
}

const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const START_LINK_PREFIX = "link-";
const LINK_INSTRUCTIONS =
  "🔗 To link this Telegram account: on nearbuilders.org open Admin Dashboard → Telegram, tap Link my Telegram, then send me the /link command it shows.";

function commandArgument(ctx: Context): string | undefined {
  if (!ctx.message || !("text" in ctx.message)) return undefined;
  return ctx.message.text.trim().split(/\s+/, 2)[1]?.trim() || undefined;
}

async function linkWithCode(
  ctx: Context,
  dependencies: BotDependencies,
  code: string,
): Promise<void> {
  if (!ctx.from) return;
  if (!dependencies.adminChatId || !dependencies.claimTelegramLink) {
    await ctx.reply("⚠️ Telegram review linking isn’t set up on this bot.");
    return;
  }
  if (!LINK_CODE_PATTERN.test(code)) {
    await ctx.reply(`⚠️ That code doesn’t look right.\n\n${LINK_INSTRUCTIONS}`);
    return;
  }
  if (!(await isAdminGroupMember(ctx, dependencies.adminChatId, ctx.from.id))) {
    logEvent("info", "link.refused", { userId: ctx.from.id, outcome: "not_admin_group_member" });
    await ctx.reply("⛔ Only members of the admin group can link a reviewer account.");
    return;
  }
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  let linked: TelegramLinkResult;
  try {
    linked = await dependencies.claimTelegramLink({
      code,
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      name: name || null,
    });
  } catch (error) {
    logEvent("warn", "link.claim_failed", { err: error, userId: ctx.from.id });
    const reason =
      error instanceof ReviewDecisionError && error.status && error.status < 500
        ? error.message
        : "Couldn’t reach nearbuilders.org. Please try again shortly.";
    await ctx.reply(`⚠️ ${reason}`);
    return;
  }
  await ctx.reply(
    `✅ Linked. Your approvals and rejections in the admin group are now recorded as <b>${escapeHtml(linked.userLabel)}</b>.`,
    { parse_mode: "HTML" },
  );
  logEvent("info", "link.claimed", { userId: ctx.from.id });
}

async function handleLink(ctx: Context, dependencies: BotDependencies): Promise<void> {
  if (!ctx.from) return;
  if (!isPrivate(ctx)) {
    if (isAdminChat(ctx, dependencies)) {
      await ctx.reply("🔗 Send /link to me in a private chat, never in a group.");
    }
    return;
  }
  const code = commandArgument(ctx);
  if (!code) {
    await ctx.reply(LINK_INSTRUCTIONS);
    return;
  }
  await linkWithCode(ctx, dependencies, code);
}

async function handleStart(ctx: Context, dependencies: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return;
  const payload = commandArgument(ctx);
  if (payload?.startsWith(START_LINK_PREFIX)) {
    await linkWithCode(ctx, dependencies, payload.slice(START_LINK_PREFIX.length));
    return;
  }
  await ctx.reply(
    [
      "👋 I'm Chief, the NEAR Builders review bot. I post the daily review queue in the admin group and let admins approve or reject submissions there.",
      "",
      LINK_INSTRUCTIONS,
    ].join("\n"),
  );
}

export async function setCommandMenus(bot: Telegraf, adminChatId: string): Promise<void> {
  await bot.telegram.setMyCommands(
    [{ command: "link", description: "Link this Telegram account to your nearbuilders.org admin account" }],
    { scope: { type: "all_private_chats" } },
  );
  await bot.telegram.setMyCommands([], { scope: { type: "all_group_chats" } });
  if (adminChatId) {
    try {
      await bot.telegram.setMyCommands(
        [{ command: "pending", description: "Show the review queue now" }],
        { scope: { type: "chat", chat_id: adminChatId } },
      );
    } catch (error) {
      logEvent("warn", "bot.admin_command_menu_failed", {
        err: error,
        outcome: "check_ADMIN_CHAT_ID",
      });
    }
  }
  logEvent("info", "bot.command_menus_set", { adminChat: Boolean(adminChatId) });
}

export function createBot(
  token: string,
  dependencies: BotDependencies = productionDependencies,
): Telegraf {
  const bot = new Telegraf(token, { telegram: { agent: telegramAgent } });
  const reviewFlow = createReviewFlow({
    ...(dependencies.adminChatId ? { adminChatId: dependencies.adminChatId } : {}),
    siteUrl: config.nearBuildersSiteUrl,
    ...(dependencies.reviewDigest ? { reviewDigest: dependencies.reviewDigest } : {}),
    ...(dependencies.decideReview ? { decideReview: dependencies.decideReview } : {}),
  });
  bot.start((ctx) => handleStart(ctx, dependencies));
  bot.command("pending", (ctx) => handlePending(ctx, dependencies));
  bot.command("link", (ctx) => handleLink(ctx, dependencies));
  bot.on(message("pinned_message"), (ctx) => handleOwnPinNotice(ctx, dependencies));
  bot.on(message("text"), (ctx, next) => reviewFlow.handleReasonReply(ctx, next));
  bot.action(/^rv:/, (ctx) => reviewFlow.handleCallback(ctx));
  bot.catch(async (error, ctx) => {
    logEvent("error", "telegram.update.failed", {
      err: error,
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id,
      userId: ctx.from?.id,
      outcome: "unhandled_error",
    });
    try {
      await ctx.reply("❌ Something went wrong while handling that request. Please try again shortly.");
    } catch (replyError) {
      logEvent("error", "telegram.failure_response.failed", {
        err: replyError,
        updateId: ctx.update.update_id,
        outcome: "last_resort_reply_failed",
      });
    }
  });
  return bot;
}
