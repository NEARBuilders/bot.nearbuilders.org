# Chief

Chief is the NEAR Builders admin review bot on Telegram. It lives in one private admin group, posts the review
queue every weekday, and lets linked admins approve or reject submissions from Telegram.

It is a separate bot from the onboarding bot in `../telegram`: its own token, its own nearbuilders.org
API key, and its own Railway services. It has no database; the website owns the queue, the Claude
evaluations, reviewer links, permissions and the audit log.

## What it does

| Where | Command / action | What happens |
| --- | --- | --- |
| Admin group | daily digest (cron) | Posts the queue grouped by verdict (🟢 ready, 🟡 needs a look, ⏳ not evaluated, 🔴 likely spam), pins it, deletes the previous one. Nothing on empty days, except a Monday all-clear. |
| Admin group | `/pending` | Posts the current queue now. |
| Admin group | category buttons | Opens a list with **Approve / Reject** per item. Likely-spam items are reject-only. |
| Admin group | **Approve** | Confirm tap; items not marked ready show a warning with Claude's reason first. |
| Admin group | **Reject** | One of four preset reasons, or **✍️ Custom reason**: the admin replies with their own text within 10 minutes. |
| Private chat | `/link` | For admin group members: a one-time link (10 minutes) to `/admin/telegram-link` on nearbuilders.org. Confirming it while signed in as an admin links this Telegram account to that admin account. |
| Private chat | `/start` | Explains the bot. |

Every tap is checked by the website first (a dry run): the tapper must have a linked admin account,
and the item must still be pending and unchanged. Decisions are recorded under the linked admin's
account, as "admin.near (via Telegram)". After a decision the list re-renders and the pinned digest's
counts update.

Linked accounts are listed in the admin dashboard's **Telegram** tab. Remove access there when someone
stops being an admin: the website cannot re-check admin status on each tap.

## Processes

| Process | Command | Runs |
| --- | --- | --- |
| Polling bot | `node dist/index.js` (`npm start`) | Always on. **Exactly one instance**: Telegram allows one long-poll per token, and custom-reason requests are held in memory. |
| Digest job | `node dist/digest.js` (`npm run digest`) | Cron `0 10 * * 1-5` (weekdays 10:00 UTC). Runs once and exits. |

## Setup

1. Create a bot named **Chief** with @BotFather and put its token in `TELEGRAM_BOT_TOKEN`.
2. Create a private Telegram group for admins. Turn off "Add Members" for non-admins, revoke the
   default invite link, and hide chat history for new members.
3. Add the bot and promote it with only **Pin messages** and **Delete messages**. Promoting can
   upgrade the group to a supergroup with a new ID, so read the ID afterwards: send `/pending` in the
   group and look for `chatId` in the log, then set `ADMIN_CHAT_ID`.
4. Create a dedicated **non-admin** nearbuilders.org account and an API key from it. Grant the key
   `{"reviews":["read","write"]}` in the auth database and put it in `NEARBUILDERS_API_KEY`.
   Admin-owned keys carry full admin rights, so never use one here.
5. Each admin sends `/link` to the bot in a private chat and confirms on the website.

```bash
cp .env.example .env
npm install
npm run dev          # polling bot with reload
npm run digest:dev   # run the digest once
npm test
npm run typecheck
```

Telegram rejects `localhost` button URLs, so keep `NEARBUILDERS_SITE_URL` on a public HTTPS URL even
when the API overrides point at a local site.

## Deploying on Railway

Project **nearbuilders.org**, two new services from this repo, both with **Root Directory**
`/chief` and **Watch Paths** `/chief/**` (so changes here never redeploy the onboarding or X bots).
The `Dockerfile` builds both.

| Service | Start command | Settings |
| --- | --- | --- |
| `chief.bot.nearbuilders.org` | default (`node dist/index.js`) | 1 replica, restart on failure, no public domain |
| `chief-digest.bot.nearbuilders.org` | `node dist/digest.js` | Cron `0 10 * * 1-5`, restart never |

Variables on both: `TELEGRAM_BOT_TOKEN`, `NEARBUILDERS_API_KEY`, `ADMIN_CHAT_ID`; on the digest also
`DIGEST_HEARTBEAT_URL` (optional). Deploy the website changes first; the bot calls endpoints that only
exist there.
