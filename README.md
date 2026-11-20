# opencodegram

Telegram control plane for OpenCode.

Control sessions, models, files, diffs, forms and permissions from Telegram,
with per-topic isolation, rich status cards and inline keyboards. Almost every
action is reachable from a button, so typing slash commands is optional.

## Features

- **Sessions** — create, switch, fork, rename, archive, delete; one session per
  topic; no cross-topic leakage.
- **Display modes** — flexible (configurable session card) or unified: a pinned
  dashboard (M1) with controls, model, resource indicators and tool stats, plus
  a conversation card (M2) that follows the chat and streams the latest thought
  at the bottom.
- **Status & transcript** — paginated session card with thinking, tool calls,
  shell output, edits and final answer. Contextual keyboards per state
  (working / done / stopped / error), turn receipt with duration, edits and
  detected test runs, telemetry (`⏱ · ⚡ tok/s · tok · % ctx`), actionable
  errors and copy answer/prompt/command buttons. Exports to HTML, Markdown,
  JSON-LD and JSONL (fine-tuning) with per-turn user prompts.
- **Models** — free models first, variant selection, agent picker.
- **Files** — `/ls`, `/find`, `/read`, `/tree`, `/zip`, `/file`; safe path
  confinement; inline preview and document sends.
- **Media** — photos, documents, audio, voice and video; voice transcription
  via a whisper.cpp-compatible CLI, a bundled HuggingFace Whisper wrapper (auto
  language detection), or a persistent SSE daemon (`WHISPER_DAEMON_URL`).
- **Forms & tool approvals** — interactive forms with option buttons;
  allow/reject and reject-with-reason for tool permissions. Granular
  per-thread/topic ACLs (viewer/operator/admin, read-only) are managed
  separately from `/permissions` or the panel, using `@username` or numeric IDs.
- **VCS & worktrees** — branch/status, diff, worktree create/remove/switch.
- **Settings** — per-chat profiles and toggles for display/delivery, thinking,
  tools, shell, previews, artifacts, voice, compact final, card theme and
  verbosity, plus a collapsible resource block and a compact activity summary
  (`3 pensamientos · 3 lecturas · 1 herramienta ▾`, expandable in the same card
  with per-file diff/read buttons).
- **SQLite & button-driven UI** — all persisted state lives in a single
  `data/opencodegram.db` (legacy JSON files are imported and kept as a mirror).
  `🏠 Panel` exposes sessions, models, files, status, settings, permissions and
  a `🗄 Datos` SQLite overview with admin-only VACUUM. `⚡ Comandos` turns both
  OpenCode and bot commands into buttons.
- **Docker** — two-service stack (`opencode` + bot) with optional OpenCode Browse
  (real browser via extension) and always-on Playwright MCP (headless Chromium
  for web debugging). OpenCode pinned to 2.3.0.
- **MCP events** — experimental events from OpenCode 2.3.0 shown on the card;
  fork/subagent badges and background-subagent counts.
- **Web app** — `/web` opens a private Mission Control page (enabled only when
  `WEB_APP_TOKEN` is set) with live session and metric data; groups get inline
  buttons only.
- **Tests** — 400 Bun tests across 42 files + TypeScript typecheck + build.

## Quick start

Requires Bun and a reachable OpenCode HTTP server at `OPENCODE_BASE_URL`
(default `http://127.0.0.1:49374`). The Docker stack below starts both services.

```bash
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_USER_ID (or ALLOWED_TELEGRAM_USER_IDS)
bun install
bun run doctor
bun run dev
```

Without `ADMIN_TELEGRAM_USER_ID` or `ALLOWED_TELEGRAM_USER_IDS` the bot ignores
every message.

## Docker

The repository ships a `docker-compose.yml` with two services: `opencode` (the
OpenCode HTTP server) and `bot` (this Telegram bot).

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID, OPENCODE_SERVER_PASSWORD
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d
docker compose logs -f
```

After changing `.env`, recreate the affected containers (restart alone is not
enough; provider keys are consumed by `opencode` too):

```bash
docker compose up -d --force-recreate bot opencode
```

See [docs/SETUP.md](docs/SETUP.md) for provider keys, voice notes, webhooks and
troubleshooting.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 logs opencodegram
pm2 reload opencodegram
```

The app reads `.env` automatically under Bun; `ecosystem.config.cjs` already
sets `env_file: ".env"`. Extra process-level variables can be added to its
`env` block.

## Commands

| Group | Commands |
| --- | --- |
| Sessions | `/start`, `/help`, `/status`, `/session`, `/sessions`, `/running`, `/use`, `/new`, `/stop`, `/abort`, `/retry`, `/cancel`, `/fork`, `/rename`, `/archive`, `/unarchive`, `/delete`, `/deletesessions` |
| Models | `/models`, `/model`, `/agents`, `/agent`, `/skill`, `/skills` |
| Files | `/file`, `/ls`, `/find`, `/read`, `/tree`, `/zip` |
| Session tools | `/diff`, `/context`, `/sync`, `/compact`, `/usage`, `/todos`, `/search` |
| Project | `/vcs`, `/branches`, `/branch`, `/stage`, `/unstage`, `/commit`, `/worktrees`, `/worktree`, `/forms`, `/formreply`, `/mcp` |
| Chat | `/settings`, `/permissions`, `/commands`, `/ops`, `/web`, `/buttons`, `/unlink` |

Full reference: [docs/COMMANDS.md](docs/COMMANDS.md). All of them can also be
launched from `🏠 Panel` → `⚡ Comandos` as buttons; dangerous commands are
intentionally excluded from buttons.

## Tests

```bash
bun test
bun run typecheck
bun run build
```

## Documentation

- [Setup](docs/SETUP.md)
- [Commands](docs/COMMANDS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](ROADMAP_NEXT.md)
- [Agent guide](AGENTS.md)

## Safety

- All file paths are resolved with `realpath` and confined to the session
  directory.
- External symlinks are shown but cannot be opened.
- Documents are capped at 45 MB.
- Rate limits retry at `:15` of the current hour (or the next one if already
  past `:15`).
- Per-update error isolation keeps one bad update from stopping the bot.

## Notes

- Access control: by default only `ADMIN_TELEGRAM_USER_ID` and the IDs in
  `ALLOWED_TELEGRAM_USER_IDS` may interact. In groups the bot responds to
  commands addressed to it, mentions of its own username (detected
  automatically from Telegram, not configured in `.env`), or replies to the
  bot. Per-thread/topic ACLs can grant operator/admin roles or set read-only
  mode.
- Runtime state lives in a single SQLite database, `data/opencodegram.db`
  (ignored by git). Legacy `data/*.json` files are imported at startup and kept
  as a readable mirror; an external edit of a JSON file wins and is re-imported.
  A standalone `permissions.db` from older versions is imported once. Telegram
  polling offset (`telegram_offset.json`) is stored in that database together
  with the numeric bot ID; the offset resets automatically when the bot ID
  changes, so switching bots while keeping `data/` does not stall polling. The
  token itself is not compared. To force a reset, stop the bot, set `offset` to
  `0` in `data/telegram_offset.json` (keep `botId`) and start it again: the
  edited file wins and is re-imported into SQLite.
- Almost everything is reachable from inline buttons: `🏠 Panel` → sessions,
  models, files, status, settings, granular permissions and the `🗄 Datos`
  SQLite overview (with admin-only VACUUM). `⚡ Comandos` exposes both OpenCode
  and bot commands as buttons, so typing `/commands` is rarely necessary.
- Telegram long polling requires a single consumer per token. Webhook mode is
  also supported (`WEBHOOK_MODE=true`, see [docs/SETUP.md](docs/SETUP.md)) and
  replaces polling. If updates stop arriving, check `getWebhookInfo` (clear the
  webhook if set) and ensure no other instance is polling the same token. In
  Docker, `.env` changes require recreating the container
  (`docker compose up -d --force-recreate`).
