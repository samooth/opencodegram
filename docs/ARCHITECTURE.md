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

## Turn lifecycle

1. Prompt → `startStatus` creates the status card and clears previous artifacts.
2. `session.text.delta` → draft; `reasoning`/`tool` events update the card.
3. `session.step.ended` with `finish !== "tool-calls"` → `finishStatus`
   (fallback: `session.idle`). Thinking and tools stay collapsible, Stop is
   removed.
4. `session.text.ended` → final answer as a new message and topic title sync.
