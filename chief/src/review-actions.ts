import { Markup } from "telegraf";
import type {
  CategoryCount,
  DetailRow,
  DigestCategory,
} from "./digest-message.js";
import type { RejectionReason } from "./review-decision-api.js";

export interface ReviewAction {
  number: number;
  proposalId: string;
  submissionCount: number;
  title: string;
}

export type ReviewCallback =
  | {
      kind:
        | "ask_approve"
        | "ask_reject"
        | "ask_dismiss"
        | "confirm_approve"
        | "confirm_dismiss"
        | "ask_custom_reason";
      proposalId: string;
      submissionCount: number;
    }
  | { kind: "confirm_reject"; reason: RejectionReason; proposalId: string; submissionCount: number }
  | { kind: "list"; category: DigestCategory }
  | { kind: "refresh_list"; category: DigestCategory }
  | { kind: "cancel" };

const CATEGORY_CODES: Record<DigestCategory, string> = {
  ready: "r",
  review: "n",
  overdue: "o",
  spam: "s",
  failed: "f",
  pending: "p",
};

const CATEGORY_BUTTONS: Record<DigestCategory, string> = {
  ready: "🟢 Ready",
  review: "🟡 Needs a look",
  overdue: "⏰ Overdue",
  spam: "🔴 Spam",
  failed: "⚠️ Failed",
  pending: "🕒 Pending",
};

export const REJECTION_REASONS: ReadonlyArray<{ reason: RejectionReason; code: string; label: string }> = [
  { reason: "incomplete", code: "i", label: "Incomplete" },
  { reason: "not_near", code: "n", label: "Not NEAR-related" },
  { reason: "spam", code: "s", label: "Spam" },
  { reason: "duplicate", code: "d", label: "Duplicate" },
];

type KeyboardButton = { text: string; callback_data?: string; url?: string };

const CALLBACK_LIMIT = 64;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,48}$/;

export function canActOn(proposalId: string): boolean {
  return PROPOSAL_ID.test(proposalId);
}

function encode(parts: Array<string | number>): string {
  const data = ["rv", ...parts].join(":");
  if (data.length > CALLBACK_LIMIT) throw new Error("Callback data exceeds Telegram's limit");
  return data;
}

export function parseReviewCallback(data: string): ReviewCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "rv") return null;
  if (parts[1] === "x" && parts.length === 2) return { kind: "cancel" };
  if ((parts[1] === "l" || parts[1] === "lr") && parts.length === 3) {
    const category = (Object.keys(CATEGORY_CODES) as DigestCategory[]).find(
      (key) => CATEGORY_CODES[key] === parts[2],
    );
    if (!category) return null;
    return parts[1] === "l" ? { kind: "list", category } : { kind: "refresh_list", category };
  }
  const tail = parts[1] === "cr" ? parts.slice(3) : parts.slice(2);
  if (tail.length !== 2) return null;
  const [proposalId, count] = tail as [string, string];
  const submissionCount = Number.parseInt(count, 10);
  if (!canActOn(proposalId) || !Number.isSafeInteger(submissionCount) || submissionCount < 0) {
    return null;
  }
  switch (parts[1]) {
    case "a":
      return { kind: "ask_approve", proposalId, submissionCount };
    case "r":
      return { kind: "ask_reject", proposalId, submissionCount };
    case "d":
      return { kind: "ask_dismiss", proposalId, submissionCount };
    case "ca":
      return { kind: "confirm_approve", proposalId, submissionCount };
    case "cd":
      return { kind: "confirm_dismiss", proposalId, submissionCount };
    case "cc":
      return { kind: "ask_custom_reason", proposalId, submissionCount };
    case "cr": {
      const reason = REJECTION_REASONS.find((entry) => entry.code === parts[2])?.reason;
      return reason ? { kind: "confirm_reject", reason, proposalId, submissionCount } : null;
    }
    default:
      return null;
  }
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

export function digestKeyboard(message: {
  categories: CategoryCount[];
  singleReady: ReviewAction | null;
  dashboardUrl: string;
}) {
  const rows = [];
  if (message.singleReady) {
    const { proposalId, submissionCount, title } = message.singleReady;
    rows.push([
      Markup.button.callback(
        `✅ Approve ${shorten(title, 24)}`,
        encode(["a", proposalId, submissionCount]),
      ),
      Markup.button.callback("❌ Reject", encode(["r", proposalId, submissionCount])),
    ]);
  }
  const categoryButtons = message.categories.map(({ category, count }) =>
    Markup.button.callback(
      `${CATEGORY_BUTTONS[category]} (${count})`,
      encode(["l", CATEGORY_CODES[category]]),
    ),
  );
  for (let index = 0; index < categoryButtons.length; index += 2) {
    rows.push(categoryButtons.slice(index, index + 2));
  }
  rows.push([Markup.button.url("Open review dashboard", message.dashboardUrl)]);
  return Markup.inlineKeyboard(rows);
}

export function listCategory(rows: KeyboardButton[][] | undefined): DigestCategory | null {
  for (const button of rows?.flat() ?? []) {
    const parsed = button.callback_data ? parseReviewCallback(button.callback_data) : null;
    if (parsed?.kind === "refresh_list") return parsed.category;
  }
  return null;
}

export function detailKeyboard(rows: DetailRow[], category: DigestCategory) {
  return Markup.inlineKeyboard([
    ...rows.map((row) => {
      const buttons: Array<
        ReturnType<typeof Markup.button.url> | ReturnType<typeof Markup.button.callback>
      > = [
        Markup.button.url(
          `${row.number} · ${shorten(row.title, row.canApprove ? 14 : 22)} ↗`,
          row.url,
        ),
      ];
      if (row.proposalId !== null && row.submissionCount !== null) {
        if (row.canApprove) {
          buttons.push(
            Markup.button.callback("✅ Approve", encode(["a", row.proposalId, row.submissionCount])),
          );
        }
        if (row.canReject) {
          buttons.push(
            Markup.button.callback("❌ Reject", encode(["r", row.proposalId, row.submissionCount])),
          );
        }
        if (row.canDismiss) {
          buttons.push(
            Markup.button.callback("🗂 Dismiss", encode(["d", row.proposalId, row.submissionCount])),
          );
        }
      }
      return buttons;
    }),
    [
      Markup.button.callback("🔄 Refresh", encode(["lr", CATEGORY_CODES[category]])),
      Markup.button.callback("✖ Close", encode(["x"])),
    ],
  ]);
}

export function approveConfirmKeyboard(proposalId: string, submissionCount: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Confirm approve", encode(["ca", proposalId, submissionCount])),
      Markup.button.callback("Cancel", encode(["x"])),
    ],
  ]);
}

export function dismissConfirmKeyboard(proposalId: string, submissionCount: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🗂 Confirm dismiss", encode(["cd", proposalId, submissionCount])),
      Markup.button.callback("Cancel", encode(["x"])),
    ],
  ]);
}

export function rejectReasonKeyboard(proposalId: string, submissionCount: number) {
  return Markup.inlineKeyboard([
    REJECTION_REASONS.slice(0, 2).map((entry) =>
      Markup.button.callback(entry.label, encode(["cr", entry.code, proposalId, submissionCount])),
    ),
    REJECTION_REASONS.slice(2).map((entry) =>
      Markup.button.callback(entry.label, encode(["cr", entry.code, proposalId, submissionCount])),
    ),
    [
      Markup.button.callback("✍️ Custom reason", encode(["cc", proposalId, submissionCount])),
      Markup.button.callback("Cancel", encode(["x"])),
    ],
  ]);
}


export function withoutProposalButtons(
  rows: KeyboardButton[][],
  proposalId: string,
): KeyboardButton[][] {
  return rows.filter(
    (row) => !row.some((button) => button.callback_data?.includes(`:${proposalId}:`)),
  );
}
