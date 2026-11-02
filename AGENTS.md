# AGENTS.md

This file gives coding agents the context needed to work safely in
`opencodegram`.

## Project

`opencodegram` is a Telegram control plane for OpenCode. A Bun + TypeScript
daemon runs under PM2, polls Telegram, and talks to the local OpenCode HTTP
server plus its event stream. The admin user is `REDACTED_USER_ID`; the bot is
`@your_bot`.

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

Do not delete `zigcache9` (13 GB) or other large directories without explicit
permission. `/ai` is usually above 90% full, so keep commits and temporary files
small and clean them up.

## Environment

`.env` (not committed):

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_USER_ID` (default admin: `REDACTED_USER_ID`)
- `OPENCODE_BASE_URL` (default `http://127.0.0.1:49374`)
- `OPENCODE_DIRECTORY` (optional session directory)

OpenCode 2.2.0 runs locally. The daemon reads `.env` automatically under Bun.

## Architecture

Main modules:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Config, clients, dependency wiring, command menu |
| `context.ts` | Shared `BotDeps` |
| `store.ts` | Route tables and JSON persistence (`data/*.json`) |
| `sessions.ts` | Create, activate, restore, retire sessions; topic title sync |
| `status.ts` | Status card lifecycle, drafts, thinking, tools, Stop |
| `events.ts` | OpenCode event stream to Telegram, artifacts, retries |
| `panels.ts` | Panel, sessions, models and commands views |
| `callbacks.ts` | Inline buttons and permission decisions |
| `commands.ts` | Slash commands and `KNOWN_COMMANDS` |
| `messages.ts` | Access control, media download, prompts, command dispatch |
| `updates.ts` | Polling loop and update dispatch |
| `telegram.ts` | Telegram client |
| `util.ts` | Escaping, clamping, thread options, retry time, command parsing |
| `files.ts` | Safe path resolution, listing, search, text preview, documents, zip |
| `transcribe.ts` | Local voice-note transcription |
| `filebrowser.ts` | `/ls`, `/find`, `/read` rendering and inline navigation |

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

`bun test` covers:

- `tests/store.test.ts` — route/tab isolation, persistence, retirement.
- `tests/files.test.ts` — path confinement, symlinks, list/find/read, `/file`.
- `tests/filebrowser.test.ts` — listing, navigation, preview, search, expiry,
  document sends.
- `tests/commands.test.ts` — command dispatch, usage, safe `/file`.
- `tests/util.test.ts` — `:15` retry timing, mention normalization, parsing.

## Conventions

- Keep changes consistent with the modular structure.
- Preserve HTML escaping with `esc`.
- Use `threadOpts(threadId)` for topic replies.
- Handle errors per update so one bad update does not stop the bot.
- In groups, respond only to commands, mentions to `@your_bot`, or replies to
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

`data/` is ignored by git and contains:

- `active.json`, `threads.json`, `chats.json`
- `audit.log`

Do not commit runtime state.
