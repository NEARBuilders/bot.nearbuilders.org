# NEAR Builders Telegram Bot

A Telegram bot for nominating and onboarding builders to the [NEAR](https://near.org) ecosystem. Any group member can nominate someone directly from a group chat, the bot contacts them via DM to walk through a profile setup, and on completion submits their profile to the NEAR Builders API for review.

---

## Features

- `/onboard` command in any group - two ways to use it:
  - By username: `/onboard @username` (anywhere in the chat)
  - By reply: send `/onboard` as a reply to the target user's message
- Nominated users are messaged directly to complete their profile
- Username lookup uses a three-tier approach: DB (most reliable) > Telegram API > username-only fallback
- Pending nominations stored by username - if a user can't be resolved immediately, the nomination is saved and claimed automatically when they start the bot
- If the user hasn't started the bot yet, a group message is posted with a **💬 Start Chat** button
- Emoji reactions on the `/onboard` command message - no group message flooding:
  - 🎉 - user has already completed their onboarding
  - 👀 - user has been nominated and is in progress
- Full DM onboarding flow with a dedicated question per field
- NEAR address is mandatory with format validation (`.near`, `.tg`, or 64-character hex)
- **☄️ Create NEAR Wallet** button linking to Meteor Wallet for users without an address
- Skills selection via interactive toggle buttons (tap to add/remove)
- Links builder via guided Add Link flow (label > URL, repeatable)
- Summary review at the end with per-field edit buttons in a 2-column grid and a full-width Confirm & Submit button
- Users who have already submitted cannot restart the onboarding flow
- Submits to the NEAR Builders API on confirmation
- PostgreSQL logging of nominated users, nomination events, and pending nominations
- Rotating log file at `logs/bot.log`

---

## Onboarding Flow

```
/onboard @username  (or as a reply to a message)
  │
  ├─> Already completed > 🎉 reaction on command message
  ├─> Nominated, in progress > 👀 reaction on command message
  │
  ├─> If user ID known: DM sent immediately
  └─> If user ID unknown: nomination saved, 💬 Start Chat button posted in group
        └─> User clicks Start Chat > /start
              └─> Pending nomination claimed automatically
                    ├─> NEAR Address (mandatory, validated)
                    ├─> Name (optional)
                    ├─> Bio (optional, max 1000 chars - trimmed if exceeded)
                    ├─> Skills (toggle button selection)
                    ├─> Location (optional)
                    ├─> Links (guided Add Link flow)
                    └─> Summary with edit buttons
                          └─> Confirm & Submit > POST to NEAR Builders API
```

All fields except NEAR Address are optional. Users can skip optional steps using the ⏭️ Skip button.

---

## /start Behaviour

| Scenario | Response |
|---|---|
| Not nominated | "You will need to be nominated to enter the bot!" |
| Already completed | "You've already submitted your builder profile!" |
| Nominated, not yet started | Welcome message + onboarding begins |
| Nominated, mid-onboarding | Restarts onboarding from the beginning |

---

## Prerequisites

- Python 3.10+
- A PostgreSQL database
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A NEAR Builders API key

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/NEARBuilders/bot.nearbuilders.org.git
cd bot.nearbuilders.org
```

### 2. Create and activate a virtual environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here       # Bot token from BotFather
DATABASE_URL=postgresql://user:password@localhost:5432/nearbuilders  # Postgres connection
NEARBUILDERS_API_URL=https://nearbuilders.org/api/proposals          # POST endpoint
NEARBUILDERS_API_KEY=your_api_key_here       # API key from NEAR Builders dashboard
NEAR_WALLET_URL=https://wallet.meteorwallet.app  # Wallet creation link shown to users

# Optional: override the default allowed skills list (comma-separated)
# ALLOWED_SKILLS=Frontend,Backend,Rust,Typescript,DeFi
```

### 5. BotFather setup

In [@BotFather](https://t.me/BotFather):

Go to **Bot Settings > Group Privacy > Turn Off** so the bot can read messages in groups without being @mentioned.

The bot command menu is intentionally left empty to prevent the `/` button from auto-firing the command before a username is entered.

### 6. Update the bot username

In `bot.py`, update this line to match your bot's actual username - required for the Start Chat button sent to unregistered users:

```python
BOT_USERNAME = "@nearbuildersbot"
```

### 7. Run

```bash
python bot.py
```

The database tables are created automatically on first run. If upgrading from an earlier version, `setup_db` will automatically apply any missing column migrations on restart - no manual SQL needed.

---

## Running via Windows Task Scheduler

1. Create a new task in Task Scheduler
2. Set **Action** to: `cmd /c "cd /d C:\path\to\bot.nearbuilders.org && venv\Scripts\python.exe bot.py"`
3. Logs will be written to `logs\bot.log` in the bot directory automatically

---

## Project Structure

```
bot.nearbuilders.org/
├── bot.py              # Main bot - all Telegram handlers and entry point
├── conversation.py     # State machine for the onboarding flow
├── config.py           # Allowed skills list (env override supported)
├── db.py               # PostgreSQL connection, schema, and queries
├── api_client.py       # POST to the NEAR Builders API
├── requirements.txt    # Pinned dependencies
├── .env.example        # Environment variable template
└── logs/               # Created automatically on first run
    └── bot.log
```

---

## Database Schema

**`bot_users`** - every user who has been nominated (grants them access through `/start`)

| Column | Type | Description |
|---|---|---|
| `user_id` | BIGINT | Telegram user ID (primary key) |
| `username` | TEXT | Telegram @username |
| `first_name` | TEXT | Telegram first name |
| `started_at` | TIMESTAMPTZ | When they were first registered |
| `updated_at` | TIMESTAMPTZ | Last updated |
| `completed_at` | TIMESTAMPTZ | When they submitted their profile (null if not yet submitted) |

**`nomination_log`** - every `/onboard` event

| Column | Type | Description |
|---|---|---|
| `id` | SERIAL | Primary key |
| `nominated_user_id` | BIGINT | Who was nominated (null if unknown at nomination time) |
| `nominated_username` | TEXT | @username of the nominated user |
| `nominated_by_user_id` | BIGINT | Who nominated them |
| `group_chat_id` | BIGINT | Which group the command was used in |
| `created_at` | TIMESTAMPTZ | When it happened |

**`pending_nominations`** - nominations where the user ID couldn't be resolved at nomination time

| Column | Type | Description |
|---|---|---|
| `username` | TEXT | @username (primary key, lowercase) |
| `nominated_by_user_id` | BIGINT | Who nominated them |
| `group_chat_id` | BIGINT | Which group the command was used in |
| `created_at` | TIMESTAMPTZ | When it happened |

When the nominated user clicks Start Chat and sends `/start`, the pending record is claimed automatically - their real user ID is resolved, they are registered in `bot_users`, and the pending record is deleted.

---

## Username Lookup

When `/onboard @username` is used, the bot resolves the target user via three methods in order:

1. **DB lookup** - checks `bot_users` by username. Most reliable if they've previously interacted with the bot
2. **Telegram API** - calls `get_chat_member` to resolve the username to a user ID
3. **Username-only fallback** - if both fail, stores a pending nomination in `pending_nominations` and posts a group message with a **💬 Start Chat** button. The nomination is claimed automatically when they `/start` the bot

---

## API Integration

On confirmation, the bot POSTs to `https://nearbuilders.org/api/proposals` with the following body:

```json
{
  "pluginId": "builders",
  "entityId": "yourname.near",
  "payload": {
    "name": "Your Name",
    "bio": "Short bio",
    "skills": ["Rust", "DeFi"],
    "location": "Remote",
    "links": {
      "github": "https://github.com/yourname"
    }
  },
  "source": "telegram",
  "metadata": {
    "nominatedBy": "telegram:123456789",
    "telegramChatId": -1001234567890
  }
}
```

- `entityId` uses the NEAR address if provided, otherwise falls back to `telegram:<user_id>`
- All payload fields except `entityId` are optional
- `nominatedBy` and `telegramChatId` are sourced from the nomination log in the database

---

## Default Skills List

The following skills are available by default. Override via `ALLOWED_SKILLS` in `.env`:

`Frontend` · `Backend` · `Product Owner` · `Smart Contract` · `Rust` · `Typescript` · `DeFi` · `AI Automation` · `DevOps` · `Data`

---

## Dependencies

```
anyio==4.13.0
certifi==2026.5.20
h11==0.16.0
httpcore==1.0.9
httpx==0.27.0
idna==3.16
psycopg2-binary==2.9.12
python-dotenv==1.0.1
python-telegram-bot==21.6
sniffio==1.3.1
```

---

## License

MIT
