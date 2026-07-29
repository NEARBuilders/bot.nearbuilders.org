# Python-to-TypeScript Parity Audit

The archived files in `src-old/` are byte-for-byte identical to the Python
files at the `v2` branch point. The TypeScript implementation preserves the
same Telegram flows, database schema, API contract, configuration defaults,
and operational behavior.

## Verified parity

| Area | Result |
|---|---|
| `/start` access gate | Pending nomination claim, rejection, restart, and completed-profile responses match |
| `/onboard` command | Username, reply, unresolved-user, bot, completed, existing-user, and new-user branches match |
| Group responses | Messages reply to the command and remain in the same forum topic |
| Reactions | 🎉 for completed profiles and 👀 for active nominations |
| Questions and keyboards | Text, HTML parse mode, labels, callback data, row layout, wallet URL, skip behavior, and edit summary match |
| Conversation state | Step order, edit return, optional skips, skill toggles, links, and in-memory session lifecycle match |
| Validation | NEAR account formats and Python-compatible Unicode name/bio limits match |
| Submission | API URL, headers, 15-second timeout, body filtering, metadata, and 200/201 success handling match |
| PostgreSQL | Tables, columns, migrations, case-insensitive lookups, upserts, completion, pending claims, and latest nomination query match |
| Startup | Command menus are cleared, all supported update types are polled, and SIGINT/SIGTERM stop polling and close PostgreSQL |
| Logging | Console plus `logs/bot.log`, 5 MB rotation, and three backups |

## Intentional safety differences

These changes preserve intended behavior without reproducing Python failure
modes:

- Telegram HTML interpolations are escaped.
- Skill callbacks accept only configured skills.
- Pending nomination claims use a row lock and transaction.
- The Start Chat URL uses Telegram's actual bot username unless
  `BOT_USERNAME` overrides it.
- Mandatory-address callbacks are acknowledged once with the intended alert.
- Invalid command targets are handled instead of raising an exception.
- Configuration errors fail clearly and shutdown closes the connection pool.

The original unused `SKILL_MAX_CHARS`, link removal helper, pending-nomination
check, link-label confirmation keyboard, and `link_label_confirm:*` callback
surface are retained for source compatibility.
