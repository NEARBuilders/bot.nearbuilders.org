# Repository Guidelines

## Project Structure & Module Organization

The maintained application is a Node.js 20+ TypeScript Telegram bot. Production
code lives in `src/`: `index.ts` starts polling, `bot.ts` defines Telegram
handlers, and `nomination-api.ts` requests website-owned nomination and lifecycle
state. Configuration and logging are in `config.ts` and
`logger.ts`. `src-old/` is the archived Python implementation;
use it only as a migration reference. Compiled output goes to `dist/`, while
runtime logs go to `logs/`; neither should be committed. `PARITY.md` records the
Python-to-TypeScript behavior audit.

## Build, Test, and Development Commands

- `npm install` installs the locked dependencies from `package-lock.json`.
- `npm run dev` runs `src/index.ts` with `tsx` and restarts on file changes.
- `npm test` runs the nomination API tests with Node's test runner.
- `npm run typecheck` checks strict TypeScript types without generating output.
- `npm run build` compiles `src/` into `dist/`.
- `npm start` runs the previously compiled `dist/index.js`.

Copy `.env.example` to `.env` and provide Telegram and NEAR Builders credentials
before running the bot.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes,
semicolons, trailing commas in multiline constructs, and explicit return types
for exported or substantial functions. Use `camelCase` for variables and
functions, `PascalCase` for types, and kebab-case filenames such as
`nomination-api.ts`. Keep ESM imports compatible with `NodeNext` by using `.js`
extensions for local TypeScript modules. Preserve the strict compiler settings,
including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. There is
currently no separate formatter or linter; `npm run typecheck` is the minimum
required static check.

## Testing Guidelines

Tests use Node's built-in test runner through `tsx`; keep them near the source
as `*.test.ts`. For every change, run `npm test`, `npm run typecheck`, and
`npm run build`. Manually exercise affected Telegram flows against a test bot
and deployed API, especially nomination, recovery, API failure, lifecycle, and
website handoff paths. No coverage threshold is currently configured.

## Commit & Pull Request Guidelines

Recent commits use concise, imperative, sentence-case subjects, for example
`Port from Python to TypeScript` and `Update README.md`. Keep each commit focused
and avoid committing `.env`, logs, generated output, or credentials. Pull
requests should explain the behavior change, list validation commands, note
configuration or database implications, and link related issues. Include
screenshots or a short Telegram interaction transcript when user-visible flows
change.

## Security & Configuration

Treat bot tokens, API keys, and signing secrets as confidential. Use safe
placeholders in `.env.example`; validate external input before API use.
