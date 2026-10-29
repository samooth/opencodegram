# opencodegram

Telegram control plane for OpenCode.

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
pm2 restart opencodegram
pm2 stop opencodegram
pm2 save
```

The app reads `.env` automatically when run with Bun. For PM2, either export the variables in the shell before `pm2 start`, or add them to `env` in `ecosystem.config.cjs`.

## Docs

See [docs/](./docs/).

## Commands

- `/start`, `/help`, `/status` — panel and active session
- `/sessions`, `/use <id>`, `/new` — session browser and switching
- `/models`, `/agents` — model/variant and agent pickers
- `/file <path>` — send a local file as a document
- `/diff`, `/context`, `/sync`, `/compact`, `/usage` — session tools
- `/vcs`, `/worktrees`, `/forms`, `/formreply` — project tools
- `/stop` — stop the active turn
- any other text — prompt the active session

Full reference: [docs/COMMANDS.md](docs/COMMANDS.md).
EOF