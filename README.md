# opencodegram

Telegram control plane for OpenCode.

Control sessions, models, files, diffs, forms and permissions from Telegram,
with per-topic isolation, rich status cards and inline keyboards.

## Features

- **Sessions** — create, switch, fork, rename, archive, delete; one session per
  topic; no cross-topic leakage.
- **Display modes** — flexible (configurable session card) or unified: a pinned
  dashboard (M1) with controls, model, resource indicators and tool stats, plus
  a conversation card (M2) that follows the chat and streams the latest thought
  at the bottom.
- **Status & transcript** — paginated session card with thinking, tool calls,
  shell output, edits, tok/s, Stop button and final answer; long answers can be
  sent as separate rich-text messages with a “Ver completo” action. Exports to
  HTML, Markdown, JSON-LD and JSONL (fine-tuning) with per-turn user prompts.
- **Models** — free models first, variant selection, agent picker.
- **Files** — `/ls`, `/find`, `/read`, `/zip`, `/file`; safe path confinement;
  inline preview and document sends.
- **Media** — photos, documents, audio, voice and video; voice transcription
  via whisper.cpp or a bundled HuggingFace Whisper wrapper (auto language
  detection).
- **Forms & permissions** — interactive forms with option buttons, allow/reject,
  reject-with-reason.
- **VCS & worktrees** — branch/status, diff, worktree create/remove/switch.
- **Settings** — profiles and toggles for display/delivery, thinking, tools,
  shell, previews, artifacts, voice, compact final, card theme, verbosity, compact activity summary (`+3 thoughts · 3 reads · 1 tool`, expandable in place, plus an explicit ▾ Ver detalles toggle) and streaming transcription.
- **Docker** — two-service stack (`opencode` + bot) with optional OpenCode Browse
  (real browser via extension) and always-on Playwright MCP (headless Chromium
  for web debugging). OpenCode pinned to 2.3.0.
- **MCP events** — experimental events from OpenCode 2.3.0 shown on the card;
  fork/subagent badges and background-subagent counts.
- **Tests** — 225 Bun tests across 31 files + TypeScript typecheck.

## Quick start

```bash
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID, OPENCODE_BASE_URL
bun install
bun run doctor
bun run dev
```

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

After changing `.env`, recreate the bot container (restart alone is not enough):

```bash
docker compose up -d --force-recreate bot
```

See [docs/SETUP.md](docs/SETUP.md) for provider keys, voice notes, webhooks and
troubleshooting.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 logs opencodegram
pm2 reload opencodegram
```

The app reads `.env` automatically under Bun. For PM2, export the variables or
add them to `ecosystem.config.cjs`.

## Commands

| Group | Commands |
| --- | --- |
| Sessions | `/start`, `/help`, `/status`, `/session`, `/sessions`, `/running`, `/use`, `/new`, `/stop`, `/abort`, `/retry`, `/cancel` |
| Models | `/models`, `/model`, `/agents`, `/agent` |
| Files | `/file`, `/ls`, `/find`, `/read`, `/zip` |
| Session tools | `/diff`, `/context`, `/sync`, `/compact`, `/usage`, `/todos` |
| Project | `/vcs`, `/worktrees`, `/worktree`, `/forms`, `/formreply`, `/mcp` |
| Chat | `/settings`, `/commands`, `/ops`, `/buttons`, `/unlink`, `/fork`, `/rename`, `/archive`, `/unarchive`, `/delete` |

Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).

## Tests

```bash
bun test
bun run typecheck
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
- Rate limits retry at `:15` of the next hour.
- Per-update error isolation keeps one bad update from stopping the bot.

## Notes

- Admin-only bot; in groups it responds to commands, mentions to the configured
  bot username, or replies to the bot.
- Runtime state lives in `data/` (ignored by git), including the Telegram
  polling offset (`telegram_offset.json`). The offset is stored with the bot
  identity and reset automatically if the bot/token changes, so switching to a
  different bot while keeping `data/` does not stall polling. If you run an
  older version and hit this, remove `data/telegram_offset.json` and restart.
- Telegram long polling requires a single consumer per token and no webhook.
  If updates stop arriving, check `getWebhookInfo` (clear the webhook if set)
  and ensure no other instance is polling the same token. In Docker, `.env`
  changes require recreating the container (`docker compose up -d --force-recreate`).
