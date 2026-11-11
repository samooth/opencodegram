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

Do not delete large directories without explicit permission. Keep commits and
temporary files small and clean them up.

## Environment

`.env` (not committed):

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_USER_ID` (the admin user; defaults to none if unset)
- `OPENCODE_BASE_URL` (default `http://127.0.0.1:49374`)
- `OPENCODE_DIRECTORY` (optional session directory)
- `REPOS_DIRECTORY` (optional folder containing repositories; enables choosing a repo when creating a session)

OpenCode 2.2.x runs locally. The daemon reads `.env` automatically under Bun.

## Architecture

Main modules:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Config, clients, dependency wiring, command menu |
| `context.ts` | Shared `BotDeps` |
| `store.ts` | Route tables and JSON persistence (`data/*.json`) |
| `sessions.ts` | Create, activate, restore, retire sessions; topic title sync |
| `status.ts` | Turn/status lifecycle, live strip, M2 publishing and mode behavior |
| `dashboard.ts` | Pinned dashboard (M1) in unified mode: controls, model, resources, tool stats |
| `transcript.ts` | Transcript blocks, splitting and pagination |
| `transcriptmanager.ts` | Session card (M2): serialized publish, pagination, refloat/recovery |
| `resources.ts` | CPU/GPU/RAM/VRAM/temp indicators |
| `events.ts` | OpenCode event stream to Telegram, artifacts, retries, final-answer delivery |
| `panels.ts` | Panel, sessions, models and commands views |
| `callbacks.ts` | Inline buttons, settings/profiles and permission decisions |
| `commands.ts` | Slash commands and `KNOWN_COMMANDS` |
| `messages.ts` | Access control, media download, prompts, command dispatch |
| `updates.ts` | Polling loop, update dispatch, offset persistence |
| `telegram.ts` | Telegram client (messages, rich text, documents, pin/unpin) |
| `util.ts` | Escaping, clamping, thread options, retry time, command parsing |
| `files.ts` | Barrel re-export of `files/*` |
| `files/*` | Safe path resolution, listing, search, text preview, documents, zip, summary, tree |
| `autoretry.ts` | Bounded auto-retry state after rate limits |
| `ratethrottle.ts` | Adaptive per-chat edit throttle after Telegram 429s |
| `botcommands.ts` | Single source of `BOT_COMMANDS` |
| `constants.ts` | Named intervals and limits |
| `editutil.ts` | Edit detection and diff formatting |
| `formui.ts` | Interactive form rendering and keyboards |
| `logger.ts` | Structured logging |
| `mcp.ts` | MCP server/resource bridge |
| `metrics.ts` | Counters and error recording |
| `ops.ts` | Health endpoint, metrics, disk guard |
| `settings.ts` | Persistent per-chat settings (modes, profiles, delivery, toggles) |
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

`bun test` covers (131 tests across 18 files):

- `tests/store.test.ts` — route/tab isolation, persistence, retirement,
  reply-to message routing and dead-chat binding cleanup.
- `tests/files.test.ts` — path confinement, symlinks, list/find/read, `/file`.
- `tests/filebrowser.test.ts` — listing, navigation, preview, search, expiry, documents.
- `tests/commands.test.ts` — command dispatch, usage, safe `/file`.
- `tests/util.test.ts` — `:15` retry timing, mention normalization, parsing.
- `tests/autoretry.test.ts` — bounded auto-retry, stale-prompt guard.
- `tests/ratethrottle.test.ts` — adaptive edit throttle (429 penalties, decay).
- `tests/callbacks.test.ts`, `tests/events.test.ts`, `tests/panels.test.ts`,
  `tests/sessions.test.ts`, `tests/status.test.ts`, `tests/updates.test.ts` —
  handlers, rendering and routing.
- `tests/settings.test.ts` — per-chat settings, persistence and normalization.
- `tests/transcript.test.ts` — pagination, limits/dedupe, rendering, recovery and refloat.
- `tests/transcribe.test.ts` — voice transcription config and execution.
- `tests/promptdedupe.test.ts` — stripping restated prompts from reasoning.
- `tests/summary.test.ts` — file summaries, search and tree rendering.

## Conventions

- Keep changes consistent with the modular structure.
- Preserve HTML escaping with `esc`.
- Use `threadOpts(threadId)` for topic replies.
- Handle errors per update so one bad update does not stop the bot.
- In groups, respond only to commands, mentions to the configured bot username, or replies to
  the bot.
- Free models first; show provider/model and variant where relevant.
- User-facing responses should be in Spanish.

## Offloading (zig-ai) — casos y plan

Casos de residencia VRAM/RAM/NVMe y plan de flexibilidad total:
`/ai/repos/2026/zig-ai/CASOS.md` y `/ai/repos/2026/zig-ai/PLAN_CASOS.md`.

Esquema rápido:
- A capas densas parciales (VRAM+RAM) — layer streaming.
- B pesos VRAM, KV RAM — `--kv-offload`.
- C MoE hot VRAM / cold RAM-NVMe — `offload_cache`.
- D pipeline híbrido por capa.
- E todo en NVMe.
- F KV en NVMe (contextos gigantes).
- G multi-GPU.
- H presupuesto adaptativo por prioridad.

## Runtime state

`data/` is ignored by git and contains persisted runtime state, including route
bindings and mappings (`active.json`, `threads.json`, `chats.json`,
`messages.json`, `delivery.json`, `last*`, `topicTitles.json`), Telegram polling
offset/identity (`telegram_offset.json`), session data (`transcripts.json`,
`statusMessages.json`, `dashboard.json`, `cot.json`, `pendingEdits.json`,
`buttons.json`), per-chat settings (`settings.json`) and logs (`audit.log`,
`sessions.log`).

`telegram_offset.json` stores the confirmed update offset and the bot `botId`;
on startup the offset is reset if the bot identity changes, so switching bots
while keeping `data/` does not stall polling.

Do not commit runtime state.
