import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  formatAllClearMessage,
  formatCategoryDetail,
  formatDigestMessage,
  isDigestText,
} from "./digest-message.js";
import type { ReviewDigest, ReviewDigestItem } from "./review-digest-api.js";

const OPTIONS = { siteUrl: "https://nearbuilders.org/" };

function item(overrides: Partial<ReviewDigestItem> = {}): ReviewDigestItem {
  return {
    id: "proposal_1",
    pluginId: "builders",
    entityId: "alice.near",
    title: "Alice",
    submittedBy: "bob.near",
    detail: null,
    submissionCount: 1,
    evaluation: null,
    state: "pending",
    createdAt: "2026-09-24T09:00:00.000Z",
    ageDays: 2,
    isNew: false,
    isStale: false,
    dashboardPath: "/admin/dashboard/builders?item=alice.near&status=pending",
    ...overrides,
  };
}

function evaluation(
  verdict: "ready" | "review" | "spam",
  summary = "Reason",
  source: string | null = null,
): ReviewDigestItem["evaluation"] {
  return { verdict, score: verdict === "ready" ? 90 : 40, summary, flags: [], source };
}

function digest(items: ReviewDigestItem[]): ReviewDigest {
  const pending = items.filter((entry) => entry.state === "pending");
  const byPlugin = { builders: 0, projects: 0, events: 0, nearcatalog: 0 };
  for (const entry of pending) byPlugin[entry.pluginId] += 1;
  return {
    generatedAt: "2026-09-26T09:00:00.000Z",
    staleAfterDays: 7,
    totals: {
      pending: pending.length,
      newLast24h: pending.filter((entry) => entry.isNew).length,
      stale: pending.filter((entry) => entry.isStale).length,
      needsAttention: items.length - pending.length,
      oldestPendingDays: pending[0]?.ageDays ?? null,
    },
    byPlugin,
    activity: null,
    items,
  };
}

const QUEUE = digest([
  item({
    id: "zara",
    title: "Zara Williams",
    ageDays: 54,
    isStale: true,
    evaluation: evaluation("review", "No on-chain account, no links", "web"),
  }),
  item({ id: "oliver", title: "Oliver Jensen", ageDays: 54, isStale: true, evaluation: evaluation("review") }),
  item({ id: "hana", title: "Hana Park", ageDays: 54, isStale: true, evaluation: evaluation("review") }),
  item({
    id: "sdk",
    pluginId: "projects",
    title: "NEAR Rust SDK",
    ageDays: 0,
    isNew: true,
    evaluation: evaluation("ready", "Official repo, active, live site", "telegram"),
  }),
  item({
    id: "meetup",
    pluginId: "events",
    title: "Lisbon <Meetup>",
    ageDays: 1,
    evaluation: evaluation("review", "Missing date and location"),
  }),
  item({ id: "casino", title: "CryptoWin", evaluation: evaluation("spam") }),
  item({
    id: "broken",
    pluginId: "projects",
    title: "Broken Deploy",
    state: "apply_failed",
    dashboardPath: "/admin/dashboard/projects?item=broken",
  }),
]);

test("returns null when nothing needs review", () => {
  assert.equal(formatDigestMessage(digest([]), OPTIONS), null);
});

test("trusts the item list over totals when they disagree", () => {
  const stale = { ...digest([item()]), items: [] };
  assert.equal(formatDigestMessage(stale, OPTIONS), null);
});

test("shows only counts and the oldest item", () => {
  const message = formatDigestMessage(QUEUE, OPTIONS);
  assert.ok(message);
  assert.equal(
    message.text,
    [
      "📋 <b>Review queue</b>",
      "",
      "🟢 <b>1</b> ready to approve",
      "🟡 <b>4</b> need a look (3 overdue)",
      "🔴 <b>1</b> likely spam",
      "⚠️ <b>1</b> failed to publish",
      "",
      "Oldest: <b>Zara Williams</b>, waiting 54 days",
    ].join("\n"),
  );
  assert.deepEqual(message.categories, [
    { category: "ready", count: 1 },
    { category: "review", count: 4 },
    { category: "overdue", count: 3 },
    { category: "spam", count: 1 },
    { category: "failed", count: 1 },
  ]);
  assert.deepEqual(message.singleReady, {
    number: 1,
    proposalId: "sdk",
    submissionCount: 1,
    title: "NEAR Rust SDK",
  });
  assert.equal(message.disableNotification, false);
});

test("lists overdue separately when some overdue items are not in 'needs a look'", () => {
  const message = formatDigestMessage(
    digest([
      item({ id: "a", ageDays: 10, isStale: true, evaluation: evaluation("ready") }),
      item({ id: "b", ageDays: 9, isStale: true, evaluation: evaluation("review") }),
    ]),
    OPTIONS,
  );
  assert.ok(message);
  assert.match(message.text, /🟡 <b>1<\/b> needs a look\n⏰ <b>2<\/b> overdue/);
});

test("offers no single approve when several items are ready", () => {
  const message = formatDigestMessage(
    digest([
      item({ id: "a", evaluation: evaluation("ready") }),
      item({ id: "b", evaluation: evaluation("ready") }),
    ]),
    OPTIONS,
  );
  assert.ok(message);
  assert.equal(message.singleReady, null);
  assert.match(message.text, /🟢 <b>2<\/b> ready to approve/);
});

test("falls back to pending counts before anything is evaluated", () => {
  const message = formatDigestMessage(
    digest([item({ ageDays: 9, isStale: true }), item({ id: "b", ageDays: 0 })]),
    OPTIONS,
  );
  assert.ok(message);
  assert.match(message.text, /🕒 <b>2<\/b> pending \(1 overdue\)/);
  assert.deepEqual(message.categories, [
    { category: "pending", count: 2 },
    { category: "overdue", count: 1 },
  ]);
});

test("sends silently when nothing is new, overdue, or failed", () => {
  const message = formatDigestMessage(digest([item({ evaluation: evaluation("review") })]), OPTIONS);
  assert.ok(message);
  assert.equal(message.disableNotification, true);
});

test("lists a category with one tidy block per item", () => {
  const detail = formatCategoryDetail(QUEUE, "review", OPTIONS);
  assert.equal(
    detail.text,
    [
      "🟡 <b>Needs a look</b> · 4",
      "",
      "<b>1. Zara Williams</b>\nBuilder · 54 days ⏰ · via website\n<i>No on-chain account, no links</i>",
      "",
      "<b>2. Oliver Jensen</b>\nBuilder · 54 days ⏰\n<i>Reason</i>",
      "",
      "<b>3. Hana Park</b>\nBuilder · 54 days ⏰\n<i>Reason</i>",
      "",
      "<b>4. Lisbon &lt;Meetup&gt;</b>\nEvent · 1 day\n<i>Missing date and location</i>",
    ].join("\n"),
  );
  assert.deepEqual(
    detail.rows.map((row) => [row.number, row.title, row.canApprove, row.canReject]),
    [
      [1, "Zara Williams", true, true],
      [2, "Oliver Jensen", true, true],
      [3, "Hana Park", true, true],
      [4, "Lisbon <Meetup>", true, true],
    ],
  );
  assert.equal(
    detail.rows[0]!.url,
    "https://nearbuilders.org/admin/dashboard/builders?item=alice.near&status=pending",
  );
});

test("lets ready items be approved and failed items be dismissed", () => {
  const ready = formatCategoryDetail(QUEUE, "ready", OPTIONS);
  assert.match(
    ready.text,
    /<b>1\. NEAR Rust SDK<\/b>\nProject · today · via Telegram\n<i>Official repo, active, live site<\/i>/,
  );
  assert.deepEqual(
    ready.rows.map((row) => [row.canApprove, row.canReject, row.proposalId]),
    [[true, true, "sdk"]],
  );

  const failed = formatCategoryDetail(QUEUE, "failed", OPTIONS);
  assert.match(failed.text, /<i>Approved, but publishing failed<\/i>/);
  assert.deepEqual(
    failed.rows.map((row) => [row.canApprove, row.canReject, row.canDismiss, row.proposalId]),
    [[false, false, true, "broken"]],
  );
});

test("caps long lists and long reasons", () => {
  const items = Array.from({ length: 11 }, (_, index) =>
    item({ id: `b${index}`, title: `Builder ${index}`, evaluation: evaluation("review", "x".repeat(200)) }),
  );
  const detail = formatCategoryDetail(digest(items), "review", OPTIONS);
  assert.equal(detail.rows.length, 8);
  assert.match(detail.text, /…and 3 more in the dashboard$/);
  assert.match(detail.text, new RegExp(`<i>${"x".repeat(89)}…</i>`));
});

test("says so when a category is empty", () => {
  const detail = formatCategoryDetail(digest([item()]), "spam", OPTIONS);
  assert.equal(detail.text, "🔴 <b>Likely spam</b>\n\nNothing here right now.");
  assert.deepEqual(detail.rows, []);
});

test("never offers approve on likely spam", () => {
  const detail = formatCategoryDetail(QUEUE, "spam", OPTIONS);
  assert.deepEqual(
    detail.rows.map((row) => [row.canApprove, row.canReject]),
    [[false, true]],
  );
});

test("does not offer actions on items that cannot be acted on", () => {
  const detail = formatCategoryDetail(
    digest([item({ id: "legacy", submissionCount: null, evaluation: evaluation("ready") })]),
    "ready",
    OPTIONS,
  );
  assert.deepEqual(
    detail.rows.map((row) => [row.canApprove, row.canReject]),
    [[false, false]],
  );
});

test("recognizes the bot's own digests and all-clear messages", () => {
  const message = formatDigestMessage(QUEUE, OPTIONS);
  assert.ok(message);
  assert.equal(isDigestText(message.text.replace(/<\/?b>/g, "")), true);
  assert.equal(isDigestText("📋 NEAR Builders review queue: 3 pending"), true);
  assert.equal(isDigestText(formatAllClearMessage()), true);
  assert.equal(isDigestText("Please review my project"), false);
  assert.equal(escapeHtml('<b>"x" & y</b>'), "&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;");
});
