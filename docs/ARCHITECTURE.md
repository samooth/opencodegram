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
| `status.ts` | Turn/status lifecycle, live strip, M2 publishing and mode behavior |
| `dashboard.ts` | Pinned dashboard (M1) in unified mode: controls, model, resources, tool stats |
| `transcript.ts` | Transcript blocks, splitting and pagination |
| `transcriptmanager.ts` | Session card (M2): serialized publish, pagination, refloat/recovery |
| `resources.ts` | CPU/GPU/RAM/VRAM/temp indicators |
| `events.ts` | OpenCode event stream → Telegram, artifacts, retries, final-answer delivery |
| `panels.ts` | Panel, sessions, models and commands views |
| `files.ts` | Barrel re-export of `files/*` |
| `files/*` | Safe path resolution, listing, search, text preview, documents, zip, summary, tree |
| `autoretry.ts` | Bounded auto-retry state after rate limits |
| `botcommands.ts` | Single source of `BOT_COMMANDS` |
| `callbacks.ts` | Inline buttons, settings/profiles and permission decisions |
| `commands.ts` | Slash commands and `KNOWN_COMMANDS` |
| `messages.ts` | Access control, media download, prompts, command dispatch |
| `updates.ts` | Polling loop, update dispatch, offset persistence (bot-aware) |
| `telegram.ts` | Telegram client (text, rich messages, documents, pin/unpin) |
| `util.ts` | Escaping, clamping, thread options, retry time, command parsing |
| `editutil.ts` | Edit detection and diff formatting |
| `formui.ts` | Interactive form rendering and keyboards |
| `settings.ts` | Persistent per-chat settings (modes, profiles, delivery, toggles) |
| `logger.ts` | Structured logging |
| `mcp.ts` | MCP server/resource bridge |
| `metrics.ts` | Counters and error recording |
| `ops.ts` | Health endpoint, metrics, disk guard |
| `ratethrottle.ts` | Adaptive per-chat edit throttle after Telegram 429s |
| `transcribe.ts` | Local voice-note transcription |
| `filebrowser.ts` | `/ls`, `/find`, `/read` rendering and inline navigation |
| `types.ts` | Shared types (`ChatSession`, etc.) |
| `vcs.ts` | VCS and worktree helpers |
| `webhook.ts` | Optional webhook server |
| `constants.ts` | Named intervals and limits |

## Reply-to routing

- Every bot message that belongs to a session is mapped with
  `store.rememberMessageSession` (session cards, final answers, dashboards,
  full-history exports).
- When the user replies to a bot message, `store.findSessionByAnyMessage`
  resolves the owning session from the map, falling back to the pinned
  dashboard, the status registry and in-memory card ids. The prompt is routed
  to that session (activating it in the route) instead of the tab's active
  session.
- When a chat becomes unreachable (deleted group, bot kicked), persistent
  `chat not found` failures trigger `store.forgetChatBindings`, which drops
  its dashboards, status cards, message mappings and route bindings.

## Rate limiting

- Edits are throttled per chat with base gaps (`STATUS_MIN_UPDATE_GAP_MS`,
  `STATUS_BACKGROUND_GAP_MS`); `ratethrottle.ts` multiplies the gap
  adaptively after Telegram 429 responses (×1…×4, decayed on success and
  quiet time) and exposes counters for `/ops`.

## Polling and runtime state

- Telegram updates are consumed via long polling (`getUpdates`) by a single
  process. The confirmed update offset is persisted in `data/telegram_offset.json`
  together with the bot identity (`botId`).
- On startup, if the stored `botId` differs from the current bot, the offset is
  reset to `0` and a warning is logged. This prevents polling from stalling when
  the bot/token is changed while reusing persisted `data/` (Telegram `update_id`
  sequences are per-bot). The offset is also saved on startup so the identity is
  recorded even before new updates arrive.
- Webhook mode is mutually exclusive with polling; when webhook mode is disabled
  the bot clears any registered webhook.

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

`bun test` runs the Bun suite in `tests/` (112 tests across 17 files):

- `store.test.ts` — route/tab isolation, persistence and retirement.
- `files.test.ts` — path confinement, symlinks, list/find/read and `/file`.
- `filebrowser.test.ts` — listing, navigation, preview, search, expiry and documents.
- `commands.test.ts` — command dispatch, usage and safe `/file`.
- `util.test.ts` — `:15` retry timing, mention normalization and parsing.
- `autoretry.test.ts` — bounded auto-retry and stale-prompt guard.
- `callbacks.test.ts`, `events.test.ts`, `panels.test.ts`, `sessions.test.ts`,
  `status.test.ts`, `updates.test.ts` — handlers, rendering and routing.
- `settings.test.ts` — per-chat settings, persistence and normalization.
- `transcript.test.ts` — pagination, limits/dedupe, rendering, recovery and refloat.
- `transcribe.test.ts` — voice transcription config and execution.
- `promptdedupe.test.ts` — stripping restated prompts from reasoning.
- `summary.test.ts` — file summaries, search and tree rendering.

`bun run typecheck` checks `src/` with `tsc --noEmit`.

## Display modes and turn lifecycle

- **Flexible mode** (default): one session card (M2) holds the paginated transcript
  (answers, thinking, tools), edited/refloated according to card behavior, with
  indicators at the bottom.
- **Unified mode**: up to 2 bot messages per active session in a route:
  - **M1 (dashboard, pinned best-effort)**: session/model, controls, resource
    indicators and tool-call stats; updated on turn/session events.
  - **M2 (conversation card)**: follows the conversation, streams the latest
    thought at the bottom while working, and keeps the transcript paginated.
  Profiles and long-answer delivery are configurable in `/settings`.

Turn lifecycle (one card per turn):

1. Prompt/activation → `startStatus` bumps `turnSeq` and immediately publishes
   M2, so the new card appears right away (with a 📝 prompt line) instead of
   waiting for the first model output. According to `cardBehavior`, the previous
   card is replaced (unified and `única` delete it), kept as history (`nueva`)
   or edited in place (`fija`).
2. `session.text.delta` / `reasoning` / `tool` events update M2 (and M1 stats in
   unified mode) with throttled edits. While streaming, the card shows a fresh
   view of the current turn (the live strip plus this turn's blocks) instead of
   repeating the previous turn's page; ◀ browsing still reaches the full
   history. Blocks are tagged with the turn sequence and the first block of a
   turn starts a fresh page.
3. `session.step.ended` with `finish !== "tool-calls"` (or `session.idle`) →
   `finishStatus`: thinking/tools are recorded in the transcript, Stop is
   removed and M2 is finalized; the finished card stays in place for
   pagination.
4. `session.text.ended` → final answer is added to the transcript (restoring
   the full paginated view); depending on settings/length it may also be sent
   as separate rich-text message(s) split at markdown section boundaries
   (`splitBySections`: one part per heading, code fences kept intact) and is
   available via **“Ver completo”**; topic title sync runs.

The session card keyboard offers **◀ / N/M ⊞ / ▶** (the middle button opens a
page picker grid that jumps to any page and closes itself), **⏭ Última**,
**📄 Ver completo** and **📜 Historial** (exports the full transcript as an
HTML document, including blocks trimmed from the card).
