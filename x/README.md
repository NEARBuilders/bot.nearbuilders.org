# NEAR Builders X Bot

A stateless Node.js bot that watches X for explicit NEAR Builders nominations and hands them to the NEAR Builders website API.

The bot has no database, Redis instance, queue, or contributor state. The website API owns nomination identity, idempotency, secure onboarding tokens, attribution, review status, and profile completion.

## Behavior

An approved community account publishes:

```text
@NEARBuilders !onboard @alice
```

The post author is recorded as the nominator. The explicit `@alice` handle is recorded as the nominee. Reply context is preserved as metadata but is not used to infer the nominee.

The bot:

1. Receives matching posts through X Filtered Stream.
2. Resolves the nominee handle to a stable X user ID.
3. Sends the original post, nominator, nominee, and reply metadata to the NEAR Builders API.
4. Uses `x-nomination:<post-id>` as the idempotency key.
5. Logs the result without posting a public reply.

Admins contact the nominee from the existing NEAR Builders admin queue using the secure website link returned by the API.

## Requirements

- Node.js 20 or newer
- An X app Bearer Token with Filtered Stream read access
- A dedicated NEAR Builders API key
- The X endpoint and database changes described in [`docs/nearbuilders-api-adaptation.md`](docs/nearbuilders-api-adaptation.md)

The bot uses the official [`@xdevplatform/xdk`](https://docs.x.com/tools/typescript-xdk) package for X user lookup, filtered-stream rules, and streaming.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `.env`:

```env
X_BEARER_TOKEN=your_x_app_bearer_token
X_BOT_USERNAME=NEARBuilders
NEARBUILDERS_NOMINATION_URL=https://nearbuilders.org/api/builders/nominations/x
NEARBUILDERS_API_KEY=your_nearbuilders_api_key
X_STREAM_RULE_TAG=nearbuilders-x-bot
PORT=3000
LOG_LEVEL=info
```

`X_BOT_USERNAME` may include or omit `@`. Non-loopback NEAR Builders URLs must use HTTPS.

## Commands

```bash
npm run dev
npm test
npm run typecheck
npm run build
npm start
```

## Runtime endpoints

- `GET /health` returns process health and current stream connection state.
- `GET /ready` returns `200` only while the X stream is connected.

`/health` is a liveness endpoint. Railway uses `/ready` during deployment so a
deployment is not marked active until the X filtered stream has connected.

## Failure and retry behavior

- Stream connections reconnect with exponential backoff.
- X nominee lookups retry once for transient failures.
- NEAR Builders API requests retry once for network errors, timeouts, 408, 429, and 5xx responses.
- Every retry uses the same idempotency key.
- HTTP 403 from the website API means the nominator is not approved and is not retried.
- The bot never logs API keys, Bearer Tokens, or raw nomination tokens.

The standard filtered stream is a persistent connection. If the process is down, posts published during the outage may not be replayed. The API remains idempotent, and Enterprise webhook delivery or API-owned recovery can be added later if guaranteed delivery is required.

## Deployment order

1. Apply the website/API migration and deploy the X nomination endpoint.
2. Create a dedicated API key for this bot and configure its allowed key ID in the website API.
3. Add at least one approved X nominator in the website admin UI.
4. Deploy this service with the X and NEAR Builders secrets.
5. Verify `/health` and `/ready`.
6. Publish a test nomination from an approved account.
7. Confirm the admin queue, stable join link, idempotent replay, and profile attribution.

See [`docs/nearbuilders-api-adaptation.md`](docs/nearbuilders-api-adaptation.md) for the website-side implementation checklist and smoke-test requests.
