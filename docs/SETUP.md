# Setup

## Requirements

- Bun
- OpenCode 2.2.x running locally
- Telegram bot token
- Optional: `ffmpeg` and a Whisper-compatible CLI for voice notes

## Install

```bash
cp .env.example .env
# edit .env
bun install
bun run doctor
```

## Environment

```env
TELEGRAM_BOT_TOKEN=replace-me
OPENCODE_BASE_URL=http://127.0.0.1:49374
# OPENCODE_DIRECTORY=/path/to/your/project
# ADMIN_TELEGRAM_USER_ID=123456789
# LOG_LEVEL=info
```

## Run

```bash
bun run dev
```

## Webhook mode (optional)

Long polling is the default. To use webhook mode in production:

1. Set in `.env`:
   - `WEBHOOK_MODE=true`
   - `WEBHOOK_URL=https://your-public-domain` (must be HTTPS)
   - `WEBHOOK_SECRET=<random secret>` (recommended)
   - `WEBHOOK_PORT=8443` (default)
   - `WEBHOOK_PATH=/telegram/webhook` (default)
2. Expose the port via a reverse proxy (Caddy/Nginx) with TLS, or a tunnel.
3. Restart: `pm2 reload opencodegram`.

The bot registers the webhook with Telegram on startup and validates the
`X-Telegram-Bot-Api-Secret-Token` header. In polling mode it calls
`deleteWebhook` to clear any previous registration.

For local development, keep `WEBHOOK_MODE=false` (default) and use polling.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 logs opencodegram
pm2 reload opencodegram
pm2 save
```

### Log rotation (recommended)

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

The app also rotates `data/audit.log` automatically when it exceeds 1 MB.

## Topics

Enable “Topics in Private Chats” in @BotFather for per-session threads. In
groups, topics are handled per thread when the group is a forum.

## Voice notes

Install `ffmpeg` and a Whisper-compatible CLI, then configure:

```env
VOICE_TRANSCRIBER=whisper-cli
VOICE_TRANSCRIBER_ARGS=["-m","/models/ggml-base.bin","-f","{input}","-otxt","-of","{output}"]
VOICE_TRANSCRIPTION_LANGUAGE=es
```

If no transcriber is configured, voice notes fall back to being attached as
audio.

## Verification

```bash
bun run typecheck
bun test
```
