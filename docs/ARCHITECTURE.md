# Architecture

## Runtime

- Bun + TypeScript daemon under PM2 (`ecosystem.config.cjs`).
- Telegram Bot API with long polling (`src/updates.ts`).
- OpenCode HTTP + event stream through `@opencode/client` (`src/opencode.ts`).

## Modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | Config, clients, dependency wiring, command menu |
| `context.ts` | `BotDeps` shared by update handlers |
| `store.ts` | Route tables and JSON persistence (`data/*.json`) |
| `sessions.ts` | Create, activate, restore, retire sessions; topic title sync |
| `status.ts` | Status card lifecycle, drafts, thinking, tools, Stop |
| `events.ts` | OpenCode event stream → Telegram |
| `panels.ts` | Panel, sessions, models and commands views |
| `files.ts` | Safe path resolution, listing, search, text preview and documents |
| `transcribe.ts` | Local voice-note transcription |
| `filebrowser.ts` | `/ls`, `/find`, `/read` rendering and inline navigation |
| `formui.ts` | Interactive form rendering and keyboards |
| `editutil.ts` | Edit detection and diff formatting |
| `settings.ts` | Persistent per-chat settings |
| `callbacks.ts` | Inline buttons and permission decisions |
| `commands.ts` | Slash commands |
| `messages.ts` | Access control, media download, prompts |
| `updates.ts` | Polling loop and update dispatch |
| `telegram.ts` | Telegram client (text, rich messages, documents) |
| `util.ts` | Escaping, clamping, thread options, retry time |

## Routing invariants

- A **route** is `chatId:threadId` (`threadId` omitted for the main chat).
- A route owns **exactly one** session, persisted in `data/active.json`.
- A **topic** owns exactly one session; it never falls back to another tab.
- A session lives in at most one route.
- Commands use `restoreActiveSession` and never create sessions.
- Only prompts and media use `ensureActiveSession`, which may create a session.
- Replacing a session retires the previous one: stop the turn, remove its Stop
  button and clear its routing entries.

## File access

- Every path from Telegram is resolved with `realpath` before use.
- The real target must remain inside the active session directory; `..`,
  absolute paths and symlinks that escape are rejected.
- `/file` is capped at 45 MB. `/read` reads at most 160 KB and 160 lines, and
  binary files must be downloaded with `/file`.
- The browser cache is keyed by Telegram `message_id`, so buttons on old
  listings keep working without storing paths in callback data.

## Tests

`bun test` runs the Bun suite in `tests/`:

- `store.test.ts` — route/tab isolation, persistence and retirement.
- `files.test.ts` — path confinement, symlinks, list/find/read and `/file`.
- `filebrowser.test.ts` — listing, navigation, preview, search and expiry.
- `commands.test.ts` — command dispatch, usage and safe `/file`.
- `util.test.ts` — `:15` retry timing, mention normalization and parsing.

`bun run typecheck` checks `src/` with `tsc --noEmit`.

## Turn lifecycle

1. Prompt → `startStatus` creates the status card and clears previous artifacts.
2. `session.text.delta` → draft; `reasoning`/`tool` events update the card.
3. `session.step.ended` with `finish !== "tool-calls"` → `finishStatus`
   (fallback: `session.idle`). Thinking and tools stay collapsible, Stop is
   removed.
4. `session.text.ended` → final answer as a new message and topic title sync.
