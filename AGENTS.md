# AGENTS.md

This file gives coding agents the context needed to work safely in
`opencodegram`.

## Project

`opencodegram` is a Telegram control plane for OpenCode. A Bun + TypeScript
daemon runs under PM2, polls Telegram, and talks to the local OpenCode HTTP
server plus its event stream. The admin user and bot username are configured
via `ADMIN_TELEGRAM_USER_ID` and `TELEGRAM_BOT_TOKEN` (see `.env`).

## Quick commands

```bash
bun install
bun run doctor
bun run dev
bun run typecheck   # tsc --noEmit
bun test            # Bun test suite
bun run build
```

PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 reload opencodegram
pm2 logs opencodegram
```

## Standard workflow

1. Make focused changes.
2. Run `bun run typecheck && bun test`.
3. Reload with `pm2 reload opencodegram`.
4. Commit with a concise message.
5. Report to the user in Spanish.

Nunca borres nada sin autorización explícita. Mantén los commits y los archivos
temporales pequeños y límpialos al terminar.

## Environment

`.env` (not committed):

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_USER_ID` (the admin user; defaults to none if unset)
- `ALLOWED_TELEGRAM_USER_IDS` (optional comma-separated allowlist; without
  either this or `ADMIN_TELEGRAM_USER_ID` the bot ignores all messages)
- `OPENCODE_BASE_URL` (default `http://127.0.0.1:49374`)
- `OPENCODE_DIRECTORY` (optional session directory)
- `REPOS_DIRECTORY` (optional folder containing repositories; enables choosing a repo when creating a session)
- `WEB_APP_TOKEN` (optional; enables the private Mission Control web app at
  `OPS_HOST:OPS_PORT/app?token=…`; disabled when unset)
- `WEB_APP_TITLE` (default `Mission Control`)
- `WEB_APP_URL` (optional public URL used by `/web` in private chats)
- `WEBHOOK_MODE`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_PORT`, `WEBHOOK_PATH`
  (optional webhook mode; long polling remains the default)

OpenCode 2.3.0 runs locally. The daemon reads `.env` automatically under Bun.

## Architecture

Main modules:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Config, clients, dependency wiring, command menu |
| `context.ts` | Shared `BotDeps` |
| `db.ts` | Single SQLite database (`data/opencodegram.db`) for all persisted state, with JSON migration/mirror and panel renderer |
| `permissions.ts` | Per-thread/topic ACLs (SQLite-backed), @username resolution and button panel |
| `config.ts` | Zod-validated environment configuration |
| `doctor.ts` | Startup diagnostics (`bun run doctor`) |
| `opencode.ts` | OpenCode HTTP bridge (client, models, sessions, cost) |
| `persist.ts` | Low-level atomic JSON helpers (legacy file migration source) |
| `store.ts` | Route tables and SQLite persistence (JSON mirror in `data/*.json`) |
| `sessions.ts` | Create, activate, restore, retire sessions; topic title sync |
| `status.ts` | Turn/status lifecycle, live publishing and mode behavior |
| `status-render.ts` | Pure rendering helpers for the status card (live strip, tools, diffs) |
| `activity.ts` | Per-turn compact activity counters, expandable summary and P1.2 live action rail |
| `todos.ts` | TODO checklist types and rich-HTML rendering |
| `apitypes.ts` | Shared structural types for OpenCode/Telegram payloads (no `any` in src) |
| `dangerous.ts` | Shared list of commands requiring confirmation |
| `whisper_daemon.py` | Optional persistent Whisper transcription daemon (SSE streaming) |
| `dashboard.ts` | Pinned dashboard (M1) in unified mode: controls, model, resources, tool stats |
| `transcript.ts` | Transcript blocks, splitting and pagination |
| `transcriptmanager.ts` | Session card (M2): publish, pagination, compact/reading views, turn navigation, refloat/recovery |
| `resources.ts` | CPU/GPU/RAM/VRAM/temp indicators |
| `events.ts` | OpenCode event stream to Telegram, artifacts, retries, final-answer delivery |
| `panels.ts` | Panel, sessions, models and commands views |
| `callbacks.ts` | Inline buttons, settings/profiles and permission decisions |
| `commands.ts` | Re-export of `commands/*` handlers and `KNOWN_COMMANDS` |
| `commands/*` | Handler modules (sessions, files, vcs, forms, mcp, misc, shared) |
| `messages.ts` | Access control, media download, prompts, command dispatch |
| `updates.ts` | Polling loop, update dispatch, offset persistence |
| `telegram.ts` | Telegram client (messages, rich text, documents, pin/unpin) |
| `util.ts` | Escaping, clamping, thread options, retry time, command parsing |
| `files.ts` | Barrel re-export of `files/*` |
| `files/*` | Safe path resolution, listing, search, text preview, documents, zip, summary, tree |
| `autoretry.ts` | Bounded auto-retry state after rate limits |
| `ratethrottle.ts` | Adaptive per-chat edit throttle after Telegram 429s |
| `syncview.ts` | Shared digest renderer for "Conectar" and `/sync` (header, recent messages, older timeline) |
| `botcommands.ts` | Single source of `BOT_COMMANDS` |
| `constants.ts` | Named intervals and limits |
| `editutil.ts` | Edit detection and diff formatting |
| `formui.ts` | Interactive form rendering and keyboards |
| `logger.ts` | Structured logging |
| `mcp.ts` | MCP server/resource bridge |
| `metrics.ts` | Counters and error recording |
| `ops.ts` | Health endpoint, metrics, disk guard and P2 private web app (`/app`) |
| `settings.ts` | Persistent per-chat settings, style presets, compact card and celebration/onboarding toggles |
| `transcribe.ts` | Local voice-note transcription |
| `filebrowser.ts` | `/ls`, `/find`, `/read` rendering and inline navigation |
| `types.ts` | Shared types (`ChatSession`, etc.) |
| `vcs.ts` | VCS and worktree helpers |
| `webhook.ts` | Optional webhook server |

## Routing invariants

- A route is `chatId:threadId` (`threadId` omitted for the main chat).
- A route owns exactly one session, persisted in `data/active.json`.
- A topic owns exactly one session and never falls back to another tab.
- A session lives in at most one route.
- Commands use `restoreActiveSession` and never create sessions.
- Only prompts and media use `ensureActiveSession`, which may create a session.
- Replacing a session retires the previous one.

## File access

All Telegram-supplied paths go through `resolveSafePath` in `src/files.ts`:

- resolves symlinks with `realpath`;
- rejects `..`, absolute paths and symlinks that escape the session directory;
- supports listing, find, text preview, documents and zip;
- external symlinks are displayed but cannot be opened.

Limits: documents 45 MB, text preview 160 KB / 160 lines, zip excludes
`node_modules`, `.git`, `dist` and caches.

## Tests

`bun test` covers (403 tests across 42 files):

- `tests/store.test.ts` — route/tab isolation, persistence, retirement,
  reply-to message routing and dead-chat binding cleanup.
- `tests/files.test.ts`, `tests/md-lifecycle.test.ts` — path confinement,
  symlinks, list/find/read, `/file` and create/edit/delete lifecycle of an md file.
- `tests/filebrowser.test.ts` — listing, navigation, preview, search, expiry, documents.
- `tests/ops.test.ts` — health/metrics endpoints, `/ready` failure and a busy ops
  port that must not crash the daemon.
- `tests/commands.test.ts` — command dispatch, usage, safe `/file`.
- `tests/util.test.ts` — `:15` retry timing, mention normalization, parsing.
- `tests/autoretry.test.ts` — bounded auto-retry, stale-prompt guard.
- `tests/ratethrottle.test.ts` — adaptive edit throttle (429 penalties, decay).
- `tests/activity.test.ts`, `tests/activity-integration.test.ts`,
  `tests/activity-card.test.ts`, `tests/activity-card-controls.test.ts`,
  `tests/activity-toggle-e2e.test.ts` —
  compact activity counters, event recording, header-only collapsed rows,
  per-file diff/read buttons, colored diffs, 64-byte callback_data limit and
  clearing keyboards from old cards, a collapsible resource block and real
  shell commands, file paths and line ranges extracted from raw tool JSON.
- `tests/callbacks.test.ts`, `tests/events.test.ts`, `tests/panels.test.ts`,
  `tests/sessions.test.ts`, `tests/status.test.ts`, `tests/updates.test.ts` —
  handlers, rendering and routing.
- `tests/edits.test.ts` — edit buttons and full diffs from persisted turn
  snapshots (work after restarts and new turns).
- `tests/turn-receipt.test.ts` — duration/token formatting, turn receipts and
  test-run detection (`bun test`, `pytest`, `go test`, …).
- `tests/card-actions.test.ts` — contextual card keyboards per state,
  private/group copy gating and the finished turn receipt.
- `tests/ux-p1.test.ts` — compact card and reading mode, live action rail,
  turn navigation, PR-style diff review and `.patch` export.
- `tests/ux-golden.test.ts` — golden card states, accessibility checks,
  resource indicators and the private web app.
- `tests/syncview.test.ts` — session digest rendering for Conectar and `/sync`.
- `tests/settings.test.ts` — per-chat settings, persistence and normalization.
- `tests/botcommands.test.ts` — no duplicate bot commands in the Telegram menu.
- `tests/permissions.test.ts` — per-thread ACLs, roles, read-only, @username resolution and persistence.
- `tests/db.test.ts` — SQLite migration (JSON + legacy `permissions.db`), persistence, JSON mirror and stats.
- `tests/transcript.test.ts` — pagination, limits/dedupe, rendering, recovery and refloat.
- `tests/transcribe.test.ts` — voice transcription config and execution.
- `tests/promptdedupe.test.ts` — stripping restated prompts from reasoning.
- `tests/summary.test.ts` — file summaries, search and tree rendering.
- `tests/editutil.test.ts` — edit detection, unified diffs and apply_patch parsing.
- `tests/todos.test.ts` — per-session TODO persistence and checklist rendering.
- `tests/picker.test.ts` — session picker ordering and empty state.
- `tests/messages.test.ts` — group media gating (photos/documents/voice in
  groups and private chats), commands addressed to other bots and an
  end-to-end `/ls` through the real file browser.
- `tests/resources.test.ts` — resource-block rendering and cache.
- `tests/readcache.test.ts` — text-read LRU cache.
- `tests/tok-speed.test.ts` — accumulated turn tokens and streamed-window speed.

## Conventions

- Keep changes consistent with the modular structure.
- Preserve HTML escaping with `esc`.
- Use `threadOpts(threadId)` for topic replies.
- Handle errors per update so one bad update does not stop the bot.
- In groups, respond only to commands addressed to the bot, mentions of its own
  username (detected automatically from Telegram), or replies to the bot.
- Free models first; show provider/model and variant where relevant.
- User-facing responses should be in Spanish.

## Runtime state

All persisted state lives in a single SQLite database, `data/opencodegram.db`
(WAL mode), keyed by state name in `kv_state` plus relational `permissions` and
`permission_users` tables, plus `known_users` for the @usernames seen in
updates. `data/` is ignored by git. The legacy `data/*.json`
files are kept as a readable mirror and as a migration source: they are imported
at startup (`importAllJson`), and a later external edit of a JSON file wins and
is re-imported. A legacy standalone `permissions.db` is imported once and
renamed to `.migrated`. The mirrors cover route bindings and mappings
(`active.json`, `threads.json`, `chats.json`, `messages.json`, `delivery.json`,
`last*`, `topicTitles.json`), polling offset (`telegram_offset.json`), session
data (`transcripts/` — one JSON file per session, `turnPrompts.json`,
`todos.json`, `statusMessages.json`, `dashboard.json`, `cot.json`,
`pendingEdits.json`, `buttons.json`) and per-chat settings (`settings.json`).
Logs (`audit.log`, `sessions.log`) stay on disk and rotate at 1 MB to `.1`.

The `🗄 Datos` button in the panel shows SQLite stats and lets an admin compact
the database (VACUUM) without typing a command.

`telegram_offset.json` stores the confirmed update offset and the numeric bot
`botId`; on startup the offset is reset if that ID changes, so switching bots
while keeping `data/` does not stall polling. Regenerating the token of the same
bot does **not** reset the offset — the token is not stored or compared. To force
a reset, edit `offset` to `0` in the JSON mirror (keep `botId`); the file wins and
is re-imported into SQLite on the next start.

Do not commit runtime state.
