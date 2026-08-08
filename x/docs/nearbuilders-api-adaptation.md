# NEAR Builders API adaptation for the stateless X bot

This document is the handoff for the `nearbuilders.org` maintainers. The X bot in this repository is intentionally stateless; the website API must own all durable nomination and onboarding state before the bot is deployed.

The existing Telegram flow must remain compatible.

## 1. Add the X nomination contract

Add a Builders plugin route:

```http
POST /api/builders/nominations/x
x-api-key: <dedicated-x-bot-key>
idempotency-key: x-nomination:<x-post-id>
content-type: application/json
```

Request body:

```json
{
  "source": "x",
  "sourceNominationId": "1234567890",
  "sourcePostUrl": "https://x.com/i/web/status/1234567890",
  "sourcePostText": "@NEARBuilders !onboard @alice",
  "sourcePostCreatedAt": "2026-08-04T13:00:00.000Z",
  "nominatedByXId": "987654321",
  "nominatedByXUsername": "bob",
  "nomineeXId": "456789123",
  "nomineeXUsername": "alice",
  "conversationId": "1234567890",
  "replyToPostId": null
}
```

Field requirements:

- `source` is always `x`.
- `sourceNominationId` is the X post ID and is the idempotency identity.
- X IDs are decimal strings, not JavaScript numbers.
- Usernames are normalized for matching but the submitted display values should also be retained.
- `sourcePostText` must preserve the exact text received from X.
- `sourcePostCreatedAt`, `conversationId`, and `replyToPostId` may be `null` when X does not provide them.

Successful response:

```json
{
  "nominationId": "nom_123",
  "source": "x",
  "engagementStatus": "pending_contact",
  "onboardingStatus": "awaiting_profile",
  "joinUrl": "https://nearbuilders.org/join?nomination=opaque-token",
  "proposalId": null,
  "proposalEntityId": null
}
```

Return HTTP `201` for a new record and HTTP `200` for an idempotent replay. The body must be identical for the same canonical nomination, including the secure join URL when one exists.

The bot accepts `engagementStatus` values of `pending_contact`, `contacted`, `snoozed`, `rejected`, and `completed`. It accepts the existing onboarding lifecycle values of `awaiting_profile`, `under_review`, `processing`, `accepted`, `rejected`, `removed`, and `processing_failed`.

## 2. Enforce the approved-nominator policy in the API

The API, not the bot, must be the final authority for the allowlist. Add an admin-managed table or equivalent model containing:

- Stable X user ID
- Current username
- Display name, when available
- Active/inactive status
- Created-by user ID
- Created and updated timestamps

Add admin-only operations to list, add, disable, re-enable, and remove approved X nominators. Validate nominations by stable X user ID, not by username.

Reject a nomination from an inactive or unknown nominator with HTTP `403`. Do not create a database record for that request. The X bot treats this response as a normal ignored event and does not retry it.

Use a dedicated API key for the X bot. Add a configured key ID, for example `X_NOMINATION_BOT_API_KEY_ID`, and reject other API keys on this route. Do not reuse the Telegram bot key.

## 3. Extend the existing nomination storage

Extend `builder_nominations` instead of creating a second onboarding system. Keep all existing Telegram rows and behavior intact.

Add support for:

- X post ID, URL, text, and creation timestamp
- Nominator X ID and username
- Nominee X ID and normalized username
- Conversation ID and reply-to post ID
- Nullable Telegram-specific columns for X rows
- `engagement_status`
- `engagement_updated_at`
- `engagement_updated_by`
- Internal reviewer note
- Contacted, snoozed, rejected, and completed timestamps

Add indexes for:

- `(source, source_nomination_id)`
- Nominee X ID
- Normalized nominee X username
- Nominator X ID
- Engagement status

Preserve the existing canonical nomination behavior. A repeated X post must return the same row. A different post nominating the same X user should attach to or resolve to the canonical nomination rather than create a second onboarding identity.

Store a first-class X identity for approved builder profiles. Do not rely only on searching the serialized `builders.links` value. Existing X links can be backfilled into the new identity table if needed.

## 4. Generalize secure nomination tokens

The existing Telegram flow uses signed nomination tokens and stores only token hashes. Reuse that mechanism for X:

- Generate the X join URL when the nominee X identity is resolved.
- Keep the raw token only in the returned HTTPS URL.
- Store only its hash in the database.
- Add source-neutral token resolution.
- Keep the existing Telegram resolution endpoints as compatibility wrappers.
- Allow `submitBuilderProfile` to accept either Telegram or X nomination tokens.
- Store `source: "x"` and the X nomination ID in proposal metadata.
- Finalize the X nomination after the profile proposal is created.

The existing join page currently calls Telegram-specific resolution. Update it to call the source-neutral resolver while preserving old Telegram tokens.

## 5. Add the admin review queue

Extend the existing admin dashboard at `/admin/dashboard`; do not create a separate admin application.

Add an X nominations tab with:

- Pending/contacted/snoozed/rejected/completed filters
- Original X post text and link
- Nominator and nominee identities
- Existing builder/profile match
- Canonical/duplicate information
- Secure join URL
- Profile and proposal lifecycle
- Suggested outreach text
- Internal notes

Admin actions:

- Mark contacted
- Snooze
- Reject
- Reopen
- Add note
- Copy join URL
- Copy suggested message
- Open original X post

All actions must require an authenticated admin, record the acting user, and use `expectedUpdatedAt` or equivalent optimistic concurrency protection.

## 6. Suggested implementation locations

Use the existing project architecture:

| Concern | Existing location | Required change |
| --- | --- | --- |
| Builders route contract | `plugins/builders/src/contract.ts` | Add X create, queue, allowlist, and state-transition schemas |
| Builders handlers | `plugins/builders/src/index.ts` | Add API-key and admin middleware |
| Nomination persistence | `plugins/builders/src/db/schema.ts` and `plugins/builders/src/services/builders.ts` | Add X fields, dedupe, token, and engagement state |
| API composition | `api/src/contract.ts` and `api/src/index.ts` | Expose X routes and source-neutral profile resolution |
| Join flow | `ui/src/routes/_layout/join.tsx` | Resolve both Telegram and X tokens |
| Admin UI | `ui/src/routes/_layout/_admin/admin/dashboard.tsx` | Add X nomination review and allowlist controls |

Follow the existing oRPC, Effect, Drizzle, Better Auth, and admin middleware patterns.

## 7. Required API tests

Add tests for:

1. New X nomination returns `201`.
2. Replaying the same X post returns `200` and the same nomination ID.
3. Concurrent duplicate requests create one canonical nomination.
4. An unapproved nominator returns `403` without a row.
5. Different posts for the same nominee resolve to one canonical identity.
6. The original post and both X identities are persisted exactly.
7. The join URL remains stable across retries.
8. X profile submission preserves source attribution.
9. Existing Telegram nomination tests remain green.
10. Admin engagement transitions and audit entries work.
11. Telegram and X tokens both resolve through the join flow.

## 8. Deployment order

1. Apply the database migration.
2. Deploy the Builders API and generic token resolver.
3. Configure `X_NOMINATION_BOT_API_KEY_ID` and create the dedicated API key.
4. Deploy the admin queue and allowlist UI.
5. Add one approved X nominator.
6. Deploy the X bot.
7. Publish a test post from the approved account.
8. Confirm one nomination in the admin queue.
9. Replay the same post and confirm no duplicate.
10. Complete a test builder profile and verify X attribution.

## 9. Smoke-test request

After the API is deployed, this request should create one nomination:

```bash
curl -i -X POST \
  'https://nearbuilders.org/api/builders/nominations/x' \
  -H 'content-type: application/json' \
  -H 'x-api-key: REDACTED' \
  -H 'idempotency-key: x-nomination:1234567890' \
  --data-raw '{
    "source":"x",
    "sourceNominationId":"1234567890",
    "sourcePostUrl":"https://x.com/i/web/status/1234567890",
    "sourcePostText":"@NEARBuilders !onboard @alice",
    "sourcePostCreatedAt":"2026-08-04T13:00:00.000Z",
    "nominatedByXId":"987654321",
    "nominatedByXUsername":"approved_account",
    "nomineeXId":"456789123",
    "nomineeXUsername":"alice",
    "conversationId":"1234567890",
    "replyToPostId":null
  }'
```

Repeat the exact request. The second response must be HTTP `200` with the original `nominationId` and no second row.
