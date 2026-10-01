# Admin review digest — scope

## Status (local, uncommitted)

| Piece | State |
| --- | --- |
| Digest endpoint + bot job, Monday all-clear, heartbeat | Built, tested locally |
| Submitter/detail, source, oldest wait, last 24h, weekly median | Built, tested locally |
| Single pinned digest, `/pending`, pin-notice cleanup | Built, tested locally |
| Evaluator: checks + Claude Opus 5, verdict-grouped digest | Built, tested locally |
| Smarter checks: source, same-name builders, duplicate events, new repos | Built, tested locally |
| Evaluation lease (one sweep across instances), retry of unassessed items | Built, tested locally |
| Approve/Reject buttons on 🟢 items (website-side allowlist, dry-run, confirm) | Built, tested end to end |
| `/link`: reviewers link Telegram to their admin account; dashboard Telegram tab to remove | Built, unit-tested; needs an end-to-end run |
| Admin dashboard evaluation badges, check list, Re-evaluate button | Built, typechecked; needs a visual check |

Model choice: a side-by-side run on the same 9 inputs showed Opus 5 better calibrated than Sonnet 5
(Sonnet under-rated the one genuine item and called a test entry spam). Cost ~$7.60 vs ~$2.95 per 1,000
submissions; Opus 5 stays the default (`reviewEvaluationModel`).

Security notes: API keys act as a session for their owning account, so the bot key must belong to a
non-admin account with only `reviews:read` and `reviews:write`. The evaluator is identified in-process by
a `Symbol`, which HTTP requests cannot carry.

## Goal

Once a day, tell nearbuilders.org admins what is waiting for review. Each item gets an
automatic evaluation, so admins can clear quick wins fast and spend their time on items
that need judgment. Keep the noise to a minimum: **at most one message per day, and none
when the queue is empty.**

## Decisions

| Topic | Decision |
| --- | --- |
| Delivery | One private Telegram admin group (no DMs) |
| Queues | Builders, Projects, Events, Activity (nearcatalog) |
| Quiet days | Send nothing when nothing is pending |
| Actions | Links to `/admin/dashboard` only. Approvals stay on the website (audit log, identity checks) |
| Evaluation | Deterministic checks + a Claude (Opus 5) one-line assessment, pluggable provider |
| Evaluation authority | Advisory only. Humans approve and reject everything |
| Evaluation placement | Website, at submission time. Results are stored and shown in the dashboard too |
| Message layout | Grouped by verdict, oldest first within each group |

## Current state

- The bot is stateless and uses polling. It only calls `POST /builders/nominations` (+ `/claim`).
- The website has one review queue: `GET /proposals?reviewStatus=pending`, keyed by
  `pluginId` (`builders`, `projects`, `events`, `nearcatalog`). Proposals include `createdAt`,
  `submissionCount`, `applyStatus` and a raw `payload`.
- The bot's API key is scoped to nominations. It should not read raw proposal payloads.

## Architecture

```text
submission ──▶ proposals plugin ──▶ evaluator (website)
                                      ├─ deterministic checks
                                      ├─ LLM assessment (Claude, structured output)
                                      └─ stored in proposal_evaluations

daily cron ──▶ bot `digest` job ──▶ GET /api/reviews/digest (API key: reviews:read)
                                 └─▶ one message to ADMIN_CHAT_ID (skipped if total = 0)
```

## Part A — Website (nearbuilders.org)

### A1. Review digest endpoint

`GET /api/reviews/digest` (implemented in phase 1). Requires an API key with a new `reviews:read` permission,
granted to the bot's existing key. Returns a pre-shaped summary with no raw payloads and no
PII beyond display names:

```json
{
  "generatedAt": "2026-09-26T09:00:00Z",
  "totals": { "pending": 14, "newLast24h": 3, "stale": 2, "needsAttention": 1 },
  "byPlugin": { "builders": 8, "projects": 4, "events": 1, "nearcatalog": 1 },
  "items": [
    {
      "pluginId": "projects",
      "title": "NEAR Intents Explorer",
      "ageDays": 5,
      "isNew": false,
      "verdict": "ready",
      "summary": "Active repo (commit 2d ago), live domain, clear NEAR integration.",
      "flags": [],
      "dashboardUrl": "https://nearbuilders.org/admin/dashboard/projects?item=…"
    }
  ]
}
```

- `stale` means pending for more than `STALE_AFTER_DAYS` (default 7).
- `needsAttention` counts approved items that failed or stalled while applying or removing
  (item `state`: `apply_failed`, `remove_failed`, `stalled`), so they don't get lost.
- A key with `reviews:read` can also read private proposal queues (nearcatalog) but cannot
  moderate.
- Phase 1 items carry `state`, `ageDays`, `isNew`, `isStale` and `dashboardPath`. The `verdict`,
  `summary` and `flags` fields shown above arrive with the evaluator in phase 2.

### A2. Evaluator

Runs asynchronously after a proposal is created or resubmitted (a change in
`submissionCount` triggers re-evaluation). It never blocks submission. One-off backfill for
items that are already pending.

**Deterministic checks** (each result is `pass | warn | fail` plus a reason):

| Queue | Checks |
| --- | --- |
| Projects | Repo URL reachable; last commit within 90 days; domain resolves over HTTPS; description ≥ N chars; no duplicate title, slug or repo among existing projects; owner is an approved builder |
| Builders | NEAR account exists on-chain (RPC `view_account`); linked GitHub/X reachable; nomination source (Telegram/X/self); no duplicate profile |
| Events | Start date in the future; event link reachable; not a duplicate of an existing event |
| Activity | Source link reachable; related project/builder exists |

**LLM assessment**: the submission plus the check results go to Claude (a small, cheap
model is enough; pick at build time), which returns structured output:
`{ verdict: "ready" | "review" | "spam", score: 0-100, summary: string (≤140 chars), flags: string[] }`.

Guardrails:

- Treat submission text as untrusted data. The prompt must say so, and a submission cannot
  override the check results.
- If any hard check fails, the item cannot be `ready`, whatever the LLM says.
- If the LLM call fails, store check results only, with `verdict: "review"`. Retry on the next
  resubmission or through an admin "re-evaluate" action.
- Store the model ID and prompt version alongside each result for auditing.

**Storage**: `proposal_evaluations` table with `proposalId`, `submissionCount`, `verdict`,
`score`, `summary`, `flags`, `checks` (json), `model`, `promptVersion`, `evaluatedAt`.

### A3. Dashboard

Show the verdict badge and summary in the proposal table and review sheet, and expand the
full check list there. Evaluations are then useful even outside Telegram.

## Part B — Telegram bot

### B1. Digest job

- New entrypoint `src/digest.ts` and script `npm run digest`: fetch, format, send, exit. It is
  separate from the polling process, so restarts can't cause double or missed sends.
- Scheduled once a day by the host's cron (e.g. a Railway cron service), at `DIGEST_CRON` in
  the admins' timezone.
- When `totals.pending === 0 && totals.applyFailed === 0`, send nothing and log
  `digest.skipped.empty`.
- **Silent notification** (`disable_notification: true`) when nothing is new and nothing is
  stale, so an unchanged queue doesn't ping anyone's phone.
- Retry API failures with backoff for up to ~15 min. If they still fail, send one short
  "⚠️ Couldn't build today's review digest" message. That still counts as the day's single
  message.

### B2. Message format

HTML parse mode, all user-supplied text escaped. Target under 4,096 characters: show at most
5 items per group and link to the dashboard for the rest.

```text
📋 NEAR Builders review queue: 14 pending (3 new, 2 waiting 7d+)
Builders 8 · Projects 4 · Events 1 · Activity 1

🟢 Ready to approve (5)
• [Project] NEAR Intents Explorer, 5d. Active repo, live domain
• [Builder] alice.near, 2d 🆕. Account active, nominated via Telegram
  …and 3 more

🟡 Needs a look (6)
• [Builder] bob.near, 9d ⏰. No linked GitHub, short bio
• [Event] Lisbon meetup, 1d 🆕. Link reachable, no venue listed
  …

🔴 Likely spam: 2 · ⚠️ Approved but failed to apply: 1

[Open review dashboard]
```

### B3. Config

New env vars: `ADMIN_CHAT_ID`, `NEAR_REVIEW_DIGEST_URL`, `DIGEST_MAX_ITEMS_PER_GROUP`
(default 5). The API key is the existing `NEARBUILDERS_API_KEY`, with `reviews:read` added.

### B4. Safety

- Post only to `ADMIN_CHAT_ID`. Refuse to start the job if it isn't set.
- Log counts and outcomes only, never titles or summaries (this matches the current logging
  policy).

## Phases

1. **Digest without evaluation** (implemented, not yet deployed): A1 (with `verdict: "unevaluated"`) + B1–B4. Useful on its
   own: one quiet daily count with links.
2. **Evaluation**: A2 + A3 plus a backfill. The digest switches to verdict grouping automatically.
3. **Later, if wanted**: a `/pending` command in the admin group (on demand, no extra
   scheduled messages); approve/reject buttons; a weekly "median time to review" stat.

## Acceptance criteria

- No message on days with nothing pending. Never more than one scheduled message per day.
- A digest message never exceeds Telegram's limit, and every item links to its dashboard entry.
- Every pending proposal is evaluated within ~5 minutes of submission. An evaluation failure
  never blocks or rejects a submission.
- The bot never receives raw proposal payloads. Its key can't approve or reject anything.
- Tests: formatter (grouping, truncation, escaping, empty and silent cases), digest job (skip,
  retry, failure notice), evaluator checks (fixtures per queue), and the rule that a failed
  hard check can't be `ready`.

## Open questions

1. What send time and timezone should the digest use?
2. Which admin group should it post to, and does it exist yet? (We need the chat ID and the
   bot added as a member.)
3. Where is the Telegram bot hosted? Railway cron assumes the same platform as `x/`.
4. Who owns the Anthropic API key and budget for the evaluator? Expected volume is low
   (one call per submission).
5. What evaluation thresholds should we use: repo activity window, minimum description
   length, and when something counts as stale?
