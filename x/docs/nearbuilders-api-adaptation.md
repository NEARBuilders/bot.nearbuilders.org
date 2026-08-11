# NEAR Builders API contract for the stateless X bot

The X bot only listens to X, resolves the nominee to a stable X user ID, and submits a referral. `nearbuilders.org` owns nomination state, identity links, secure onboarding links, review, attribution, and metrics.

The X bot has no contributor database and never receives or publishes secure onboarding links.

## Nomination endpoint

```http
POST /api/builders/nominations/x
x-api-key: <existing-nearbuilders-api-key>
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

Requirements:

- X IDs are decimal strings.
- `sourceNominationId` is the source post ID and matches the post URL.
- `sourcePostText` is preserved exactly as received from X.
- `sourcePostCreatedAt`, `conversationId`, and `replyToPostId` may be `null`.
- `nomineeXId` is required and is the stable canonical identity.
- The nominator and nominee must be different users.
- Any caller with the existing generic API-key permission may nominate a contributor. There is no X-specific key or nominator allowlist.

Successful response:

```json
{
  "nominationId": "nom_123"
}
```

The API returns `201` for a newly recorded source post and `200` for an exact replay. A replay with conflicting data returns `409`. The returned ID identifies the source referral and remains stable for that post.

## Website-owned behavior

The Builders plugin extends the existing nomination workflow:

- one canonical nomination is keyed by stable nominee X ID;
- every source post is retained as a separate referral;
- each referral may have its own secure website join link;
- different referrals for the same nominee resolve to one canonical onboarding identity;
- stable X IDs survive username changes;
- existing builder profiles are detected through the first-class X identity table;
- existing Telegram links and routes remain compatible.

The secure link is visible only in the authenticated admin review queue. Existing admins review the nomination and publish any X reply manually. Recording the published reply URL marks the referral contacted and counts it as a qualified engagement reply.

The website tracks pending, contacted, rejected, and completed referrals, link opens, profile submissions, conversion, and source/nominator attribution. It does not post automatically to X.

## Profile attribution

The source-neutral `/join` flow resolves Telegram and X tokens. For X registrations, proposal metadata contains:

- canonical nomination ID;
- referral nomination ID;
- source post ID;
- nominee X ID;
- nominator X ID.

The proposal source is `x`, and the idempotency key is `x-builder-profile:<canonical-nomination-id>`. Finalization happens only after proposal creation succeeds.

## Smoke test

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
    "nominatedByXUsername":"community_member",
    "nomineeXId":"456789123",
    "nomineeXUsername":"alice",
    "conversationId":"1234567890",
    "replyToPostId":null
  }'
```

Repeat the request unchanged. The second response must be `200` with the same `nominationId`.

## Rollout

1. Apply the Builders database migration.
2. Deploy the generalized Builders plugin and public API composition.
3. Deploy the source-neutral join flow and admin queue.
4. Configure this bot with the existing API key and production endpoint.
5. Submit and replay a test nomination.
6. Verify review, manual reply recording, link opening, profile submission, and attribution.
7. Enable the production X filtered stream.
