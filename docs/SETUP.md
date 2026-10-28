# Setup

## Requirements
- Bun
- OpenCode 2.2.x
- Telegram bot token

## Install
```bash
cp .env.example .env
# edit .env
bun install
bun run doctor
```

## Run
```bash
bun run dev
```

## PM2
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Topics
Enable "Topics in Private Chats" in @BotFather for per-session threads.
EOF