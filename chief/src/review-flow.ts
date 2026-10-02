import type { Context } from "telegraf";
import { acknowledgeCallbackQuery } from "./callback-query.js";
import {
  type DigestCategory,
  escapeHtml,
  formatAllClearMessage,
  formatCategoryDetail,
  formatDigestMessage,
  isDigestText,
} from "./digest-message.js";
import { logEvent } from "./logger.js";
import {
  approveConfirmKeyboard,
  detailKeyboard,
  digestKeyboard,
  listCategory,
  parseReviewCallback,
  REJECTION_REASONS,
  rejectReasonKeyboard,
  withoutProposalButtons,
} from "./review-actions.js";
import {
  ReviewDecisionError,
  type ReviewDecisionInput,
  type ReviewDecisionResult,
} from "./review-decision-api.js";
import type { ReviewDigest } from "./review-digest-api.js";

export interface ReviewFlowDependencies {
  adminChatId?: string;
  siteUrl: string;
  reviewDigest?: () => Promise<ReviewDigest>;
  decideReview?: (input: ReviewDecisionInput) => Promise<ReviewDecisionResult>;
  now?: () => number;
}

interface PendingReason {
  proposalId: string;
  submissionCount: number;
  title: string;
  userId: number;
  parentMessageId: number | null;
  parentCategory: DigestCategory | null;
  expiresAt: number;
}

type KeyboardRows = Parameters<typeof withoutProposalButtons>[0];

const REASON_TTL_MS = 10 * 60 * 1000;
const MIN_REASON_CHARS = 3;
const MAX_REASON_CHARS = 500;
const REASON_PROMPT_PREFIX = "✍️ Reply to this message";

function keyboardRows(message: unknown): KeyboardRows | undefined {
  if (typeof message !== "object" || message === null || !("reply_markup" in message)) {
    return undefined;
  }
  const markup = (message as { reply_markup?: { inline_keyboard?: KeyboardRows } }).reply_markup;
  return markup?.inline_keyboard;
}

function actorName(from: { username?: string; first_name: string }): string {
  return from.username ? `@${from.username}` : from.first_name;
}

function errorMessage(error: unknown): string {
  return error instanceof ReviewDecisionError ? error.message : "Something went wrong.";
}

export function createReviewFlow(dependencies: ReviewFlowDependencies) {
  const pendingReasons = new Map<number, PendingReason>();
  const now = () => dependencies.now?.() ?? Date.now();

  const isAdminChat = (ctx: Context) =>
    Boolean(dependencies.adminChatId) && String(ctx.chat?.id) === dependencies.adminChatId;

  const answer = async (ctx: Context, text: string, alert = false) => {
    await acknowledgeCallbackQuery(() => ctx.answerCbQuery(text, { show_alert: alert }));
  };

  const loadDigest = async () => (await dependencies.reviewDigest?.().catch(() => null)) ?? null;

  const renderList = (digest: ReviewDigest, category: DigestCategory) => {
    const detail = formatCategoryDetail(digest, category, { siteUrl: dependencies.siteUrl });
    return {
      text: detail.text,
      extra: {
        parse_mode: "HTML" as const,
        link_preview_options: { is_disabled: true },
        ...detailKeyboard(detail.rows, category),
      },
      items: detail.rows.length,
    };
  };

  const refreshList = async (
    ctx: Context,
    chatId: number,
    messageId: number,
    category: DigestCategory,
    digest: ReviewDigest,
  ) => {
    const list = renderList(digest, category);
    await ctx.telegram
      .editMessageText(chatId, messageId, undefined, list.text, list.extra)
      .catch((error: unknown) => {
        if (!String(error).includes("message is not modified")) {
          logEvent("warn", "review_flow.list_refresh_failed", { err: error });
        }
      });
  };

  const refreshPinnedDigest = async (ctx: Context, chatId: number, digest: ReviewDigest) => {
    try {
      const chat = await ctx.telegram.getChat(chatId);
      const pinned = "pinned_message" in chat ? chat.pinned_message : undefined;
      const text = pinned && "text" in pinned ? pinned.text : undefined;
      if (!pinned || pinned.from?.id !== ctx.botInfo.id || !isDigestText(text)) return;
      const message = formatDigestMessage(digest, { siteUrl: dependencies.siteUrl });
      if (message) {
        await ctx.telegram.editMessageText(chatId, pinned.message_id, undefined, message.text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...digestKeyboard(message),
        });
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          pinned.message_id,
          undefined,
          formatAllClearMessage(),
        );
      }
    } catch (error) {
      if (!String(error).includes("message is not modified")) {
        logEvent("warn", "review_flow.digest_refresh_failed", { err: error });
      }
    }
  };

  const afterDecision = async (
    ctx: Context,
    chatId: number,
    parent: { message_id: number; rows: KeyboardRows | undefined } | null,
    proposalId: string,
  ) => {
    const digest = await loadDigest();
    const category = listCategory(parent?.rows);
    if (parent && category && digest) {
      await refreshList(ctx, chatId, parent.message_id, category, digest);
    } else if (parent?.rows) {
      await ctx.telegram
        .editMessageReplyMarkup(chatId, parent.message_id, undefined, {
          inline_keyboard: withoutProposalButtons(parent.rows, proposalId) as never,
        })
        .catch(() => undefined);
    }
    if (digest) await refreshPinnedDigest(ctx, chatId, digest);
  };

  const resultLine = (result: ReviewDecisionResult, actor: string, reason?: string) => {
    const icon = result.decision === "approved" ? "✅" : "❌";
    const note = reason ? ` (${escapeHtml(reason)})` : "";
    return `${icon} <b>${escapeHtml(result.title)}</b> ${result.decision}${note} by ${escapeHtml(actor)}.`;
  };

  const handleCallback = async (ctx: Context): Promise<void> => {
    if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;
    const action = parseReviewCallback(ctx.callbackQuery.data);
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    const message = ctx.callbackQuery.message;
    if (!action || !from || chatId === undefined || !message) {
      await answer(ctx, "This button is no longer valid.");
      return;
    }
    const decideReview = dependencies.decideReview;
    if (!isAdminChat(ctx) || !decideReview) {
      logEvent("warn", "review_action.unavailable", { userId: from.id, chatId });
      await answer(ctx, "Reviewing from Telegram is not available here.", true);
      return;
    }
    const actor = { telegramId: from.id, username: from.username ?? null };
    const parentMessage = "reply_to_message" in message ? message.reply_to_message : undefined;
    const parent = parentMessage
      ? { message_id: parentMessage.message_id, rows: keyboardRows(parentMessage) }
      : null;

    if (action.kind === "cancel") {
      await answer(ctx, "Closed");
      await ctx.deleteMessage().catch(() => undefined);
      return;
    }

    if (action.kind === "list" || action.kind === "refresh_list") {
      const digest = await loadDigest();
      if (!digest) {
        await answer(ctx, "Couldn’t load the review queue right now.", true);
        return;
      }
      if (action.kind === "refresh_list") {
        await answer(ctx, "Refreshed");
        await refreshList(ctx, chatId, message.message_id, action.category, digest);
        return;
      }
      await answer(ctx, "");
      const list = renderList(digest, action.category);
      await ctx.reply(list.text, {
        ...list.extra,
        disable_notification: true,
        reply_parameters: { message_id: message.message_id },
      });
      logEvent("info", "review_action.list_opened", {
        userId: from.id,
        category: action.category,
        items: list.items,
      });
      return;
    }

    if (
      action.kind === "ask_approve" ||
      action.kind === "ask_reject" ||
      action.kind === "ask_custom_reason"
    ) {
      let allowed: ReviewDecisionResult;
      try {
        allowed = await decideReview({
          proposalId: action.proposalId,
          submissionCount: action.submissionCount,
          decision: action.kind === "ask_approve" ? "approve" : "reject",
          dryRun: true,
          actor,
        });
      } catch (error) {
        logEvent("warn", "review_action.refused", { err: error, userId: from.id });
        await answer(ctx, errorMessage(error), true);
        return;
      }
      await answer(ctx, "");
      const title = escapeHtml(allowed.title);

      if (action.kind === "ask_custom_reason") {
        const prompt = await ctx.reply(
          `${REASON_PROMPT_PREFIX} with the reason for rejecting <b>${title}</b>, <a href="tg://user?id=${from.id}">${escapeHtml(from.first_name)}</a>. The submitter will see it.`,
          {
            parse_mode: "HTML",
            disable_notification: true,
            reply_markup: { force_reply: true, selective: true },
          },
        );
        pendingReasons.set(prompt.message_id, {
          proposalId: action.proposalId,
          submissionCount: action.submissionCount,
          title: allowed.title,
          userId: from.id,
          parentMessageId: parent?.message_id ?? null,
          parentCategory: listCategory(parent?.rows),
          expiresAt: now() + REASON_TTL_MS,
        });
        await ctx.deleteMessage().catch(() => undefined);
        logEvent("info", "review_action.custom_reason_requested", { userId: from.id });
        return;
      }

      const warning =
        action.kind === "ask_approve" && allowed.verdict !== "ready"
          ? `⚠️ <b>${title}</b> wasn’t marked ready${
              allowed.summary ? `: <i>${escapeHtml(allowed.summary)}</i>` : "."
            }\nApprove anyway? It will go live on nearbuilders.org.`
          : null;
      await ctx.reply(
        warning ??
          (action.kind === "ask_approve"
            ? `Approve <b>${title}</b>? It will go live on nearbuilders.org.`
            : `Reject <b>${title}</b>? Pick a reason (the submitter will see it):`),
        {
          parse_mode: "HTML",
          disable_notification: true,
          reply_parameters: { message_id: message.message_id },
          ...(action.kind === "ask_approve"
            ? approveConfirmKeyboard(action.proposalId, action.submissionCount)
            : rejectReasonKeyboard(action.proposalId, action.submissionCount)),
        },
      );
      logEvent("info", "review_action.confirm_requested", {
        userId: from.id,
        decision: action.kind === "ask_approve" ? "approve" : "reject",
        warned: warning !== null,
      });
      return;
    }

    await answer(ctx, "Working…");
    const decision = action.kind === "confirm_approve" ? "approve" : "reject";
    try {
      const result = await decideReview({
        proposalId: action.proposalId,
        submissionCount: action.submissionCount,
        decision,
        ...(action.kind === "confirm_reject" ? { reason: action.reason } : {}),
        actor,
      });
      const reasonLabel =
        action.kind === "confirm_reject"
          ? REJECTION_REASONS.find((entry) => entry.reason === action.reason)?.label
          : undefined;
      await ctx.editMessageText(resultLine(result, actorName(from), reasonLabel), {
        parse_mode: "HTML",
      });
      logEvent("info", "review_action.completed", { userId: from.id, decision });
      await afterDecision(ctx, chatId, parent, action.proposalId);
    } catch (error) {
      logEvent("warn", "review_action.failed", { err: error, userId: from.id, decision });
      await ctx
        .editMessageText(`⚠️ Couldn’t ${decision} this item: ${escapeHtml(errorMessage(error))}`, {
          parse_mode: "HTML",
        })
        .catch(() => undefined);
    }
  };

  const handleReasonReply = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const message = ctx.message;
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (
      !message ||
      !("text" in message) ||
      !("reply_to_message" in message) ||
      !message.reply_to_message ||
      !from ||
      chatId === undefined ||
      !isAdminChat(ctx)
    ) {
      return next();
    }
    const promptId = message.reply_to_message.message_id;
    const pending = pendingReasons.get(promptId);
    const promptText =
      "text" in message.reply_to_message ? message.reply_to_message.text : undefined;
    if (!pending) {
      if (message.reply_to_message.from?.id === ctx.botInfo.id && promptText?.startsWith(REASON_PROMPT_PREFIX)) {
        await ctx.reply("This reason request expired. Tap ❌ Reject again to start over.", {
          reply_parameters: { message_id: message.message_id },
        });
        return;
      }
      return next();
    }
    if (pending.userId !== from.id) return;
    if (pending.expiresAt < now()) {
      pendingReasons.delete(promptId);
      await ctx.reply("This reason request expired. Tap ❌ Reject again to start over.", {
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }
    const reason = message.text.trim();
    if (reason.length < MIN_REASON_CHARS || reason.length > MAX_REASON_CHARS) {
      await ctx.reply(
        `The reason needs ${MIN_REASON_CHARS}–${MAX_REASON_CHARS} characters. Reply to the prompt again.`,
        { reply_parameters: { message_id: message.message_id } },
      );
      return;
    }
    pendingReasons.delete(promptId);
    if (!dependencies.decideReview) return;
    try {
      const result = await dependencies.decideReview({
        proposalId: pending.proposalId,
        submissionCount: pending.submissionCount,
        decision: "reject",
        customReason: reason,
        actor: { telegramId: from.id, username: from.username ?? null },
      });
      await ctx.telegram.editMessageText(
        chatId,
        promptId,
        undefined,
        resultLine(result, actorName(from), reason),
        { parse_mode: "HTML" },
      );
      logEvent("info", "review_action.completed", {
        userId: from.id,
        decision: "reject",
        customReason: true,
      });
      const digest = await loadDigest();
      if (digest && pending.parentMessageId !== null && pending.parentCategory) {
        await refreshList(ctx, chatId, pending.parentMessageId, pending.parentCategory, digest);
      }
      if (digest) await refreshPinnedDigest(ctx, chatId, digest);
    } catch (error) {
      logEvent("warn", "review_action.failed", { err: error, userId: from.id });
      await ctx.telegram
        .editMessageText(
          chatId,
          promptId,
          undefined,
          `⚠️ Couldn’t reject <b>${escapeHtml(pending.title)}</b>: ${escapeHtml(errorMessage(error))}`,
          { parse_mode: "HTML" },
        )
        .catch(() => undefined);
    }
  };

  return { handleCallback, handleReasonReply };
}
