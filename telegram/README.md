# NEAR Builders Telegram Bot

A stateless TypeScript Telegram bot for nominating builders and handing onboarding to
[nearbuilders.org](https://nearbuilders.org). The website owns nomination identity, stable
onboarding links, proposal submission, and review lifecycle state.

## Features

- `/onboard @username` creates or reuses a provisional username nomination.
- `/onboard` as a reply nominates the reply author by authoritative Telegram user ID.
- Telegram Start Chat links carry the website nomination ID.
- Deep-link and plain `/start` recover nominations through the Builders API.
- Stable website onboarding links are sent directly as URL buttons.
- Repeated nominations use the current website-owned lifecycle state; under-review/completed
  nominations keep the v1-style 🎉 reaction without an extra group message.
- Transient API failures are retried once with the same create idempotency key.
- Expected Telegram DM restrictions fall back to Start Chat; unexpected failures are reported.
- Polling, structured console output, and rotating `logs/bot.log` logs remain local runtime concerns.

The maintained bot has no database. The archived Python implementation under `src-old/` is only a
migration reference and is not loaded at runtime.

## Requirements

- Node.js 20 or newer
- A Telegram bot token from [BotFather](https://t.me/BotFather)
- A NEAR Builders API key whose API-key ID matches the website’s configured
  `TELEGRAM_BOT_API_KEY_ID`

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
NEAR_NOMINATION_URL=https://nearbuilders.org/api/builders/nominations
NEARBUILDERS_API_KEY=your_api_key_here
```

`BOT_USERNAME` is optional. The bot normally uses the username returned by Telegram.
`NEAR_NOMINATION_URL` may point to loopback HTTP during development; non-loopback endpoints and
website-issued join links must use HTTPS.
`LOG_LEVEL` is optional and defaults to `info`. Logs are structured JSON, written to stdout and
rotated in `logs/bot.log`. Flow events include Telegram/API outcomes, statuses, retries, and
durations without logging message bodies, profile data, credentials, or full secure URLs.

In BotFather, turn off **Bot Settings → Group Privacy** so the bot receives group commands.
Command menus are cleared automatically on startup.

## Commands

```bash
npm run dev
npm test
npm run typecheck
npm run build
npm start
```

## Onboarding flow

```text
/onboard @username
  └─ Builders API creates/reuses an awaiting-claim nomination
     └─ Start Chat deep link → /start <nominationId> → claim by Telegram ID

/onboard as a reply
  └─ Builders API creates/reuses the numeric-ID nomination
     ├─ direct DM allowed → stable nearbuilders.org join button
     └─ expected DM restriction → Start Chat deep link

/start without a payload
  └─ recover numeric-ID nomination first, then exact pending username
```

The Builders API returns one of `awaiting_claim`, `awaiting_profile`, `under_review`, `processing`,
`accepted`, `rejected`, `removed`, or `processing_failed`. A `joinUrl` is present only for
`awaiting_profile`.

## Deployment order

1. Deploy the Builders schema/plugin and website API.
2. Configure `TELEGRAM_BOT_API_KEY_ID` to the ID of the bot’s existing API key.
3. Deploy this stateless bot with that key’s secret value in `NEARBUILDERS_API_KEY`.
4. Smoke-test reply nomination, username nomination, deep-link `/start`, plain `/start`, and every
   proposal lifecycle message against the deployed API.
5. Keep the former bot database briefly for rollback only, then retire it. No legacy bot records are
   imported.
