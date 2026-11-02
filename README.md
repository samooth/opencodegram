# opencodegram

Telegram control plane for OpenCode.

Control sessions, models, files, diffs, forms and permissions from Telegram,
with per-topic isolation, rich status cards and inline keyboards.

## Features

- **Sessions** — create, switch, fork, rename, archive, delete; one session per
  topic; no cross-topic leakage.
- **Status cards** — thinking, tool calls, shell output, edits, tok/s, Stop
  button, final answer.
- **Models** — free models first, variant selection, agent picker.
- **Files** — `/ls`, `/find`, `/read`, `/zip`, `/file`; safe path confinement;
  inline preview and document sends.
- **Media** — photos, documents, audio, voice and video; voice transcription
  when a Whisper-compatible CLI is configured.
- **Forms & permissions** — interactive forms with option buttons, allow/reject,
  reject-with-reason.
- **VCS & worktrees** — branch/status, diff, worktree create/remove/switch.
- **Settings** — toggles for thinking, tools, shell, previews, artifacts, voice,
  compact final.
- **Tests** — 86 Bun tests + TypeScript typecheck.

## Quick start

```bash
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID, OPENCODE_BASE_URL
bun install
bun run doctor
bun run dev
```

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
| Sessions | `/start`, `/help`, `/status`, `/session`, `/sessions`, `/use`, `/new`, `/stop` |
| Models | `/models`, `/agents` |
| Files | `/file`, `/ls`, `/find`, `/read`, `/zip` |
| Session tools | `/diff`, `/context`, `/sync`, `/compact`, `/usage` |
| Project | `/vcs`, `/worktrees`, `/worktree`, `/forms`, `/formreply` |
| Other | `/settings`, `/commands`, `/fork`, `/rename`, `/archive`, `/unarchive`, `/delete` |

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
- Runtime state lives in `data/` (ignored by git).
