import assert from "node:assert/strict";
import test from "node:test";
import {
  canActOn,
  detailKeyboard,
  digestKeyboard,
  listCategory,
  parseReviewCallback,
  rejectReasonKeyboard,
  withoutProposalButtons,
} from "./review-actions.js";

const PROPOSAL_ID = "proposal_1786374166115_5pspu7p";

type Button = { text: string; callback_data?: string; url?: string };

test("builds the digest keyboard: single approve, category buttons, dashboard", () => {
  const keyboard = digestKeyboard({
    singleReady: { number: 1, proposalId: PROPOSAL_ID, submissionCount: 12, title: "NEAR Rust SDK" },
    categories: [
      { category: "ready", count: 1 },
      { category: "review", count: 5 },
      { category: "overdue", count: 3 },
      { category: "failed", count: 1 },
      { category: "spam", count: 2 },
    ],
    dashboardUrl: "https://nearbuilders.org/admin/dashboard",
  });
  const rows = keyboard.reply_markup.inline_keyboard as Button[][];
  assert.deepEqual(
    rows.map((row) => row.map((button) => button.text)),
    [
      ["✅ Approve NEAR Rust SDK", "❌ Reject"],
      ["🟢 Ready (1)", "🟡 Needs a look (5)"],
      ["⏰ Overdue (3)", "⚠️ Failed (1)"],
      ["🔴 Spam (2)"],
      ["Open review dashboard"],
    ],
  );
  assert.deepEqual(parseReviewCallback(rows[0]![0]!.callback_data!), {
    kind: "ask_approve",
    proposalId: PROPOSAL_ID,
    submissionCount: 12,
  });
  assert.deepEqual(parseReviewCallback(rows[1]![1]!.callback_data!), {
    kind: "list",
    category: "review",
  });
  for (const button of rows.flat()) {
    if (button.callback_data) assert.ok(button.callback_data.length <= 64);
  }
});

test("builds one proper button row per listed item", () => {
  const rows = detailKeyboard([
    {
      number: 1,
      title: "NEAR Rust SDK",
      url: "https://nearbuilders.org/admin/dashboard/projects?item=sdk",
      proposalId: PROPOSAL_ID,
      submissionCount: 2,
      canApprove: true,
      canReject: true,
    },
    {
      number: 2,
      title: "A builder with a very long display name",
      url: "https://nearbuilders.org/admin/dashboard/builders?item=b",
      proposalId: "proposal_2",
      submissionCount: 1,
      canApprove: false,
      canReject: true,
    },
    {
      number: 3,
      title: "Broken Deploy",
      url: "https://nearbuilders.org/admin/dashboard/projects?item=broken",
      proposalId: null,
      submissionCount: null,
      canApprove: false,
      canReject: false,
    },
  ], "review").reply_markup.inline_keyboard as Button[][];
  assert.deepEqual(
    rows.map((row) => row.map((button) => button.text)),
    [
      ["1 · NEAR Rust SDK ↗", "✅ Approve", "❌ Reject"],
      ["2 · A builder with a very… ↗", "❌ Reject"],
      ["3 · Broken Deploy ↗"],
      ["🔄 Refresh", "✖ Close"],
    ],
  );
  assert.deepEqual(parseReviewCallback(rows[3]![0]!.callback_data!), {
    kind: "refresh_list",
    category: "review",
  });
  assert.equal(listCategory(rows), "review");
  assert.equal(rows[0]![0]!.url, "https://nearbuilders.org/admin/dashboard/projects?item=sdk");
  assert.deepEqual(parseReviewCallback(rows[1]![1]!.callback_data!), {
    kind: "ask_reject",
    proposalId: "proposal_2",
    submissionCount: 1,
  });
  assert.deepEqual(parseReviewCallback(rows[3]![1]!.callback_data!), { kind: "cancel" });
});

test("round-trips reject reasons and cancel", () => {
  const rows = rejectReasonKeyboard(PROPOSAL_ID, 3).reply_markup.inline_keyboard as Array<
    Array<{ text: string; callback_data: string }>
  >;
  const parsed = rows.flat().map((button) => parseReviewCallback(button.callback_data));
  assert.deepEqual(
    parsed.map((entry) => (entry && "reason" in entry ? entry.reason : entry?.kind)),
    ["incomplete", "not_near", "spam", "duplicate", "ask_custom_reason", "cancel"],
  );
  for (const button of rows.flat()) assert.ok(button.callback_data.length <= 64);
});

test("rejects malformed or foreign callback data", () => {
  for (const data of [
    "",
    "nominate:1",
    "rv:a:only-id",
    "rv:a:bad id:1",
    "rv:a:x:-1",
    "rv:cr:z:proposal_1:1",
    "rv:zz:proposal_1:1",
    "rv:l:z",
    "rv:l",
  ]) {
    assert.equal(parseReviewCallback(data), null, data);
  }
  assert.equal(canActOn("x".repeat(49)), false);
});

test("removes only the decided item's buttons", () => {
  const rows = [
    [{ text: "✅ Approve 1", callback_data: "rv:a:p1:1" }, { text: "❌ Reject 1", callback_data: "rv:r:p1:1" }],
    [{ text: "✅ Approve 2", callback_data: "rv:a:p12:1" }],
    [{ text: "Open review dashboard", url: "https://nearbuilders.org/admin/dashboard" }],
  ];
  assert.deepEqual(
    withoutProposalButtons(rows, "p1").map((row) => row[0]!.text),
    ["✅ Approve 2", "Open review dashboard"],
  );
});
