# Chief (review bot)

Chief is a Node.js 20+ TypeScript Telegram bot for nearbuilders.org admin review. It is independent of
`../telegram` (onboarding) and `../x`: separate token, API key and deployment. Do not import from
those folders.

- `src/index.ts` starts polling; `src/bot.ts` wires commands; `src/review-flow.ts` holds the
  list, approve/reject and custom-reason flow; `src/review-actions.ts` builds keyboards.
- `src/digest.ts` is the one-shot daily digest entrypoint; `digest-job.ts` and `digest-message.ts`
  hold its logic.
- Website calls: `review-digest-api.ts` (read), `review-decision-api.ts` (decisions and the shared
  POST helper), `review-link-api.ts` (`/link`).
- Configuration is in `config.ts`; logs go to stdout and `logs/`, with secrets redacted.

Run `npm test` and `npm run typecheck` before finishing a change. Tests use `node:test` with fake
Telegram clients; never call the real Telegram or website APIs from tests.
