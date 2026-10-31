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
