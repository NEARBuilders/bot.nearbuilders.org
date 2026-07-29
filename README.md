# NEAR Builders Telegram Bot

A TypeScript Telegram bot for nominating and onboarding builders to the
[NEAR](https://near.org) ecosystem. Group members nominate a builder, the bot
guides that builder through profile setup in a direct message, and the completed
profile is submitted to the NEAR Builders API.

## Features

- `/onboard @username` or `/onboard` as a reply in a group
- Database, Telegram, and pending-nomination username paths
- Automatic pending-nomination claim when a nominated user sends `/start`
- Start Chat button when Telegram does not yet allow a direct message
- 🎉 completed and 👀 in-progress reactions on nomination commands
- Required NEAR account validation (`.near`, `.tg`, or 64-character hex)
- Meteor Wallet creation link
- Interactive skill toggles and guided link entry
- Editable profile summary before submission
- PostgreSQL nomination and completion records
- NEAR Builders API submission
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
npm run dev
```

Configure `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DATABASE_URL=postgresql://user:password@localhost:5432/nearbuilders
NEAR_ONBOARDING_URL=https://nearbuilders.org/api/proposals
NEARBUILDERS_API_KEY=your_api_key_here
NEAR_WALLET_URL=https://wallet.meteorwallet.app
```

`BOT_USERNAME` is optional; at runtime the bot normally uses the username
returned by Telegram. `ALLOWED_SKILLS` can override the default list with a
comma-separated value.

In BotFather, turn off **Bot Settings → Group Privacy** so the bot can receive
group commands as expected. The command menus are cleared automatically on
startup.

## Commands

```bash
npm run dev        # development mode with file watching
npm run typecheck  # strict TypeScript check
npm run build      # compile into dist/
npm start          # run the compiled bot
```

Database tables and backwards-compatible column migrations are applied
automatically at startup.

## Project structure

```text
src/
├── api-client.ts    # NEAR Builders API request
├── bot.ts           # Telegram handlers and bot construction
├── config.ts        # environment configuration and skills
├── conversation.ts  # in-memory onboarding state machine
├── db.ts            # PostgreSQL schema and queries
├── index.ts         # polling startup and graceful shutdown
└── logger.ts        # console and rotating file logging

src-old/             # archived Python implementation
```

See [PARITY.md](PARITY.md) for the Python-to-TypeScript behavior audit.

## Onboarding flow

```text
/onboard @username (or reply)
  ├─ completed → 🎉
  ├─ nominated/in progress → 👀
  ├─ known user → direct message
  └─ unknown user → pending nomination + Start Chat button
       └─ /start
          └─ NEAR address → name → bio → skills → location → links
             └─ review/edit → confirm → API submission
```

All fields except the NEAR address are optional.
