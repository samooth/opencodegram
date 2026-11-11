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

## Docker

The repository ships a `docker-compose.yml` with two services: `opencode` (the
OpenCode HTTP server) and `bot` (this Telegram bot).

### 1. Prepare `.env`

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_USER_ID, OPENCODE_SERVER_PASSWORD
# optionally OPENCODE_API_KEY / KILO_API_KEY
```

### 2. Fix data permissions (important)

The bot runs as uid 1000. Before starting, make sure the host folder is writable:

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

### 3. Start

```bash
docker compose up -d
docker compose logs -f
```

### 4. Provider API keys

- OpenCode Zen uses `OPENCODE_API_KEY` (set in `.env`, passed to the `opencode` service).
- Kilo gateway uses `KILO_API_KEY`. If your OpenCode build does not include the
  `kilo` provider, mount a config file:

```yaml
# in docker-compose.yml, service opencode:
volumes:
  - ./opencode.json:/root/.config/opencode/opencode.json:ro
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kilo": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kilo Gateway",
      "options": {
        "baseURL": "https://your-kilo-gateway-url",
        "apiKey": "YOUR_KILO_API_KEY"
      },
      "models": {
        "your-model": { "name": "Your model" }
      }
    }
  }
}
```

### 5. Update / restart

```bash
docker compose pull
docker compose up -d --build
```

After changing `.env` (token, user IDs, passwords, etc.) recreate the
container so the new environment is loaded (`restart` alone is not enough):

```bash
docker compose up -d --force-recreate bot
docker compose logs -f bot
```

If you switch to a **different Telegram bot/token** while keeping the `./data`
volume, the polling offset is reset automatically on startup (it is stored with
the bot identity in `data/telegram_offset.json`). On older versions, delete
`data/telegram_offset.json` and restart. Ensure only one instance polls the
token and that no webhook is registered (`getWebhookInfo`).

## Troubleshooting

- **Bot does not respond (no activity in logs):** confirm a single poller is
  running and no webhook is set (`curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`
  should show an empty `url`). If you changed bots with persisted `data/`,
  reset/remove `data/telegram_offset.json` (auto-handled in current versions)
  and recreate the bot container.
- **"Not authorized" in private / silent in groups:** check
  `ADMIN_TELEGRAM_USER_ID` / `ALLOWED_TELEGRAM_USER_IDS` match your Telegram
  user ID. In groups the bot responds only to commands, mentions of the
  configured bot username, or replies to the bot (and needs appropriate group
  permissions/privacy settings).

## Verification

```bash
bun run typecheck
bun test
```
