# NEAR Builders Telegram Bot

A TypeScript Telegram bot for nominating builders to the
[NEAR](https://near.org) ecosystem. A nominee confirms the nomination in a
private chat, then follows a secure link to complete onboarding on the NEAR
Builders website. The website creates and owns the handoff.

## Features

- `/onboard @username` or `/onboard` as a reply in a group
- Database, Telegram, and pending-nomination username paths
- Automatic pending-nomination claim when a nominated user sends `/start`
- Start Chat button when Telegram does not yet allow a direct message
- One-tap confirmation in the bot
- Authenticated, idempotent nomination requests to the Builders API
- Website-issued, opaque onboarding links
- Website nomination ID and confirmation records in PostgreSQL
- 🎉 confirmed and 👀 pending reactions on nomination commands
- Console and rotating `logs/bot.log` file logs

The previous Python implementation is retained in [`src-old/`](src-old/) as a
migration reference.

## Requirements

- Node.js 20 or newer
- PostgreSQL
- A Telegram bot token from [BotFather](https://t.me/BotFather)
- A NEAR Builders API key

## Setup

```bash
npm install
cp .env.example .env
npm run db:up
npm run dev
```

Configure `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DATABASE_URL=postgresql://user:password@localhost:5432/nearbuilders
NEAR_NOMINATION_URL=https://nearbuilders.org/api/builders/nominations
NEARBUILDERS_API_KEY=your_api_key_here
```

`BOT_USERNAME` is optional; at runtime the bot normally uses the username
returned by Telegram. `NEAR_NOMINATION_URL` defaults to the value shown above
and can be changed without rebuilding the bot.

`npm run db:up` starts the local PostgreSQL instance from `compose.yaml` and
waits until it is healthy. Its database, username, and password match the
default `DATABASE_URL` in `.env.example`. Data is kept in the
`postgres-data` Docker volume. Use `npm run db:down` to stop the container or
`npm run db:logs` to follow its logs.

In BotFather, turn off **Bot Settings → Group Privacy** so the bot can receive
group commands as expected. The command menus are cleared automatically on
startup.

## Commands

```bash
npm run dev        # development mode with file watching
npm run db:up      # start local PostgreSQL and wait until healthy
npm run db:down    # stop local PostgreSQL
npm run db:logs    # follow local PostgreSQL logs
npm test           # nomination API contract tests
npm run typecheck  # strict TypeScript check
npm run build      # compile into dist/
npm start          # run the compiled bot
```

Database tables and backwards-compatible column migrations are applied
automatically at startup.

## Project structure

```text
src/
├── bot.ts                      # nomination and confirmation handlers
├── config.ts                   # environment configuration
├── db.ts                       # PostgreSQL schema and queries
├── index.ts                    # polling startup and graceful shutdown
├── logger.ts                   # console and rotating file logging
├── nomination-api.ts           # website handoff API client
└── nomination-api.test.ts      # handoff contract tests

src-old/             # archived Python implementation
```

See [PARITY.md](PARITY.md) for the Python-to-TypeScript behavior audit.

## Onboarding flow

```text
/onboard @username (or reply)
  ├─ already confirmed → 🎉
  ├─ known user → confirmation in direct message
  └─ unknown user → pending nomination + Start Chat button
       └─ /start
          └─ confirm nomination
             └─ Builders API → website-issued join link
```

## Website handoff contract

After the nominee confirms, the bot sends an authenticated `POST` to
`NEAR_NOMINATION_URL`. The request uses `x-api-key` and a stable
`idempotency-key` header:

```json
{
  "source": "telegram",
  "sourceNominationId": "42",
  "nomineeTelegramId": 123,
  "nomineeUsername": "alice",
  "nominatedByTelegramId": 456,
  "telegramGroupId": -100789
}
```

The website must return HTTP 200 or 201 with:

```json
{
  "nominationId": "nom_123",
  "joinUrl": "https://join.nearbuilders.org/?nomination=opaque-token"
}
```

The bot validates the response, saves the website nomination reference, and
sends `joinUrl` without inspecting or storing its bearer token. Repeated calls
use `idempotency-key: telegram-nomination:<sourceNominationId>`; the website
returns the same stable handoff until it is successfully used.
