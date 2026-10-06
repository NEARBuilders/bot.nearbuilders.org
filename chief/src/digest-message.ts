import type {
  ReviewDigest,
  ReviewDigestItem,
  ReviewItemState,
  ReviewPluginId,
} from "./review-digest-api.js";
import { canActOn, type ReviewAction } from "./review-actions.js";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export type DigestCategory = "ready" | "review" | "overdue" | "spam" | "failed" | "pending";

export interface CategoryCount {
  category: DigestCategory;
  count: number;
}

export interface DigestMessage {
  text: string;
  dashboardUrl: string;
  disableNotification: boolean;
  categories: CategoryCount[];
  singleReady: ReviewAction | null;
}

export interface DetailRow {
  number: number;
  title: string;
  url: string;
  proposalId: string | null;
  submissionCount: number | null;
  canApprove: boolean;
  canReject: boolean;
  canDismiss: boolean;
}

export interface CategoryDetail {
  text: string;
  rows: DetailRow[];
}

interface FormatOptions {
  siteUrl: string;
}

const MAX_DETAIL_ITEMS = 8;
const MAX_REASON_CHARS = 90;
const MAX_TITLE_CHARS = 120;

export const CATEGORY_LABELS: Record<DigestCategory, { emoji: string; title: string }> = {
  ready: { emoji: "🟢", title: "Ready to approve" },
  review: { emoji: "🟡", title: "Needs a look" },
  overdue: { emoji: "⏰", title: "Overdue" },
  spam: { emoji: "🔴", title: "Likely spam" },
  failed: { emoji: "⚠️", title: "Failed to publish" },
  pending: { emoji: "🕒", title: "Pending" },
};

const TYPE_LABELS: Record<ReviewPluginId, string> = {
  builders: "Builder",
  projects: "Project",
  events: "Event",
  nearcatalog: "Activity claim",
};

const STATE_LABELS: Record<Exclude<ReviewItemState, "pending">, string> = {
  apply_failed: "Approved, but publishing failed",
  remove_failed: "Removal failed",
  stalled: "Stuck while processing",
};

const SOURCE_LABELS: Record<string, string> = {
  web: "via website",
  telegram: "via Telegram",
  x: "via X",
  "nearcatalog-claim": "via NEAR Catalog",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function days(count: number): string {
  return count === 1 ? "1 day" : `${count} days`;
}

function pendingItems(digest: ReviewDigest): ReviewDigestItem[] {
  return digest.items.filter((item) => item.state === "pending");
}

function isEvaluated(digest: ReviewDigest): boolean {
  return pendingItems(digest).some((item) => item.evaluation !== null);
}

export function categoryItems(
  digest: ReviewDigest,
  category: DigestCategory,
): ReviewDigestItem[] {
  const pending = pendingItems(digest);
  switch (category) {
    case "ready":
      return pending.filter((item) => item.evaluation?.verdict === "ready");
    case "spam":
      return pending.filter((item) => item.evaluation?.verdict === "spam");
    case "review":
      return pending.filter(
        (item) => item.evaluation?.verdict !== "ready" && item.evaluation?.verdict !== "spam",
      );
    case "overdue":
      return pending.filter((item) => item.isStale);
    case "pending":
      return pending;
    case "failed":
      return digest.items.filter((item) => item.state !== "pending");
  }
}

function actionable(
  item: ReviewDigestItem,
): item is ReviewDigestItem & { submissionCount: number } {
  return item.state === "pending" && item.submissionCount !== null && canActOn(item.id);
}

function dismissable(
  item: ReviewDigestItem,
): item is ReviewDigestItem & { submissionCount: number } {
  return item.state === "apply_failed" && item.submissionCount !== null && canActOn(item.id);
}

function countLine(emoji: string, count: number, label: string): string {
  return `${emoji} <b>${count}</b> ${label}`;
}

export function formatDigestMessage(
  digest: ReviewDigest,
  options: FormatOptions,
): DigestMessage | null {
  const pending = pendingItems(digest);
  if (pending.length === 0 && categoryItems(digest, "failed").length === 0) {
    return null;
  }

  const evaluated = isEvaluated(digest);
  const count = (category: DigestCategory) => categoryItems(digest, category).length;
  const overdue = count("overdue");
  const lines: string[] = [];
  const categories: CategoryCount[] = [];
  const push = (category: DigestCategory, value: number) => {
    if (value > 0) categories.push({ category, count: value });
  };

  if (evaluated) {
    const ready = count("ready");
    const review = count("review");
    const spam = count("spam");
    const overdueInReview = categoryItems(digest, "review").filter((item) => item.isStale).length;
    if (ready > 0) lines.push(countLine("🟢", ready, "ready to approve"));
    if (review > 0) {
      const suffix = overdue > 0 && overdueInReview === overdue ? ` (${overdue} overdue)` : "";
      lines.push(countLine("🟡", review, `need${review === 1 ? "s" : ""} a look${suffix}`));
    }
    if (overdue > 0 && overdueInReview !== overdue) {
      lines.push(countLine("⏰", overdue, "overdue"));
    }
    if (spam > 0) lines.push(countLine("🔴", spam, "likely spam"));
    push("ready", ready);
    push("review", review);
    push("overdue", overdue);
    push("spam", spam);
  } else {
    if (pending.length > 0) {
      const suffix = overdue > 0 ? ` (${overdue} overdue)` : "";
      lines.push(countLine("🕒", pending.length, `pending${suffix}`));
    }
    push("pending", pending.length);
    push("overdue", overdue);
  }

  const failed = count("failed");
  if (failed > 0) lines.push(countLine("⚠️", failed, "failed to publish"));
  push("failed", failed);

  const oldest = pending[0];
  const footer =
    oldest && oldest.ageDays > 0
      ? `\n\nOldest: <b>${escapeHtml(oldest.title)}</b>, waiting ${days(oldest.ageDays)}`
      : "";

  const readyItems = categoryItems(digest, "ready");
  const onlyReady = readyItems.length === 1 ? readyItems[0] : undefined;
  const singleReady =
    onlyReady && actionable(onlyReady)
      ? {
          number: 1,
          proposalId: onlyReady.id,
          submissionCount: onlyReady.submissionCount,
          title: onlyReady.title,
        }
      : null;

  const quiet = !pending.some((item) => item.isNew) && overdue === 0 && failed === 0;

  return {
    text: `📋 <b>Review queue</b>\n\n${lines.join("\n")}${footer}`,
    dashboardUrl: new URL("/admin/dashboard", options.siteUrl).toString(),
    disableNotification: quiet,
    categories,
    singleReady,
  };
}

function itemMeta(item: ReviewDigestItem): string {
  const age = item.ageDays === 0 ? "today" : days(item.ageDays);
  const parts = [
    TYPE_LABELS[item.pluginId],
    item.isStale ? `${age} ⏰` : age,
    item.evaluation?.source ? SOURCE_LABELS[item.evaluation.source] : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function itemReason(item: ReviewDigestItem): string {
  if (item.state !== "pending") return STATE_LABELS[item.state];
  const summary = item.evaluation?.summary.trim();
  if (!summary) return "Not evaluated yet";
  return truncate(summary, MAX_REASON_CHARS);
}

export function formatCategoryDetail(
  digest: ReviewDigest,
  category: DigestCategory,
  options: FormatOptions,
): CategoryDetail {
  const label = CATEGORY_LABELS[category];
  const items = categoryItems(digest, category);
  if (items.length === 0) {
    return {
      text: `${label.emoji} <b>${label.title}</b>\n\nNothing here right now.`,
      rows: [],
    };
  }

  const render = (shown: ReviewDigestItem[]) => {
    const blocks = shown.map(
      (item, index) =>
        `<b>${index + 1}. ${escapeHtml(truncate(item.title, MAX_TITLE_CHARS))}</b>\n${escapeHtml(itemMeta(item))}\n<i>${escapeHtml(itemReason(item))}</i>`,
    );
    const hidden = items.length - shown.length;
    const more = hidden > 0 ? `\n\n…and ${hidden} more in the dashboard` : "";
    return `${label.emoji} <b>${label.title}</b> · ${items.length}\n\n${blocks.join("\n\n")}${more}`;
  };
  let shown = items.slice(0, MAX_DETAIL_ITEMS);
  let text = render(shown);
  while (text.length > TELEGRAM_MESSAGE_LIMIT && shown.length > 1) {
    shown = shown.slice(0, -1);
    text = render(shown);
  }

  return {
    text,
    rows: shown.map((item, index) => {
      const canAct = actionable(item);
      const canDismiss = dismissable(item);
      const target = canAct || canDismiss;
      return {
        number: index + 1,
        title: item.title,
        url: new URL(item.dashboardPath, options.siteUrl).toString(),
        proposalId: target ? item.id : null,
        submissionCount: target ? item.submissionCount : null,
        canApprove: canAct && item.evaluation?.verdict !== "spam",
        canReject: canAct,
        canDismiss,
      };
    }),
  };
}

const DIGEST_PREFIXES = [
  "📋 Review queue",
  "📋 NEAR Builders review queue",
  "✅ Review queue is clear",
];

export function isDigestText(text: string | undefined): boolean {
  return Boolean(text && DIGEST_PREFIXES.some((prefix) => text.startsWith(prefix)));
}

export function formatAllClearMessage(): string {
  return "✅ Review queue is clear: nothing is waiting for approval. The bot will post again when something needs review.";
}

export function formatDigestFailureMessage(): string {
  return "⚠️ Couldn’t build today’s review digest. Check the review dashboard directly; the bot will try again tomorrow.";
}
