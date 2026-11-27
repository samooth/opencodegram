# Setup

## Requirements

- Bun
- OpenCode 2.3.0 running locally
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

The app also rotates `data/audit.log` and `data/sessions.log` automatically when they exceed 1 MB (kept as `.1`).

## Topics

Enable “Topics in Private Chats” in @BotFather for per-session threads. In
groups, topics are handled per thread when the group is a forum.

## Voice notes

Two supported setups:

**A) Whisper-compatible CLI (whisper.cpp)** — install `ffmpeg` and the CLI:

```env
VOICE_TRANSCRIBER=/path/to/whisper.cpp/build/bin/whisper-cli
VOICE_TRANSCRIBER_ARGS=["-m","/path/to/ggml-small.bin","-f","{input}","-otxt","-of","{output}"]
VOICE_TRANSCRIPTION_LANGUAGE=es
```

**B) HuggingFace model via the bundled Python wrapper** — install
`torch`, `transformers` and `librosa`, then point at the model directory:

```env
VOICE_TRANSCRIBER=/path/to/opencodegram/transcribe_whisper.py
VOICE_TRANSCRIPTION_LANGUAGE=auto
VOICE_TRANSCRIPTION_TIMEOUT_MS=120000
```

The wrapper reads the model directory from `MODEL_DIR` (set it to your local
Whisper model, for example `/path/to/models/whisper-small`). `auto` lets Whisper
detect the language.

If no transcriber is configured, voice notes fall back to being attached as
audio. In groups, voice notes are processed when they reply to the bot (or when
the bot is mentioned); photos/documents require an explicit mention.

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

## OpenCode Browse (optional)

[Browse](https://opencode.ai/product/browse) is an MCP server + Chromium
extension that lets agents use your real browser (your tabs, logins and
extensions) from Telegram. It is installed in the `opencode` Docker service
alongside **Playwright MCP** (headless Chromium for deterministic web debugging:
accessibility snapshots, console/network logs, screenshots). Browse is **optional**;
Playwright is always installed. MCP servers are generated at runtime by
`docker/entrypoint-opencode.sh` and connect automatically when OpenCode starts.

- **browse** — the user's real browser (needs the extension + pairing, see below).
- **playwright** — isolated headless Chromium inside the container, no pairing
  needed. Good for debugging a local web app: *"open localhost:3000, check the
  console for errors and take a screenshot"*.

### Setup

Browse is disabled by default (ideal for a headless VPS, where there is no
browser to pair). Enable it on a desktop with:

```bash
ENABLE_BROWSE=true docker compose up -d --build
```

The build arg installs the `browse` CLI; the runtime env var (`ENABLE_BROWSE=1`
in `.env`) makes the entrypoint register the `browse` MCP server. Playwright is
unaffected. To use Browse from a VPS you also need a secure tunnel
(Tailscale/WireGuard) and to bind the relay to `0.0.0.0` — the default compose
publishes the relay ports on `127.0.0.1` only.

1. Install the Chromium extension from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg)
   (works in Chrome, Edge, Brave, Arc, Helium, Vivaldi, Opera and Chromium).
2. Start the stack: `docker compose up -d --build`.
3. Pair your browser with the relay running inside the container:
   ```bash
   docker compose exec opencode browse pair
   ```
   This prints a one-time code (`XXXX-XXXX`). In the extension, open
   **Options → advanced → Pair with a code**, enter the code and click Connect.
   The extension connects to the relay over WebSocket on ports 19988-19992
   (published to `127.0.0.1` in `docker-compose.yml`).
4. Restart the agent so it loads the browse MCP tools: `docker compose restart opencode`.

Then ask the agent in Telegram: *"open news.ycombinator.com and tell me the top
story"*. Agent tabs open in the background in collapsed groups; when a login or
2FA is needed, the tab is handed back to you with a **Continue** button.

### Handoff and safety

- **Your tabs stay yours.** Agents only use tabs they opened or that you lend
  with the toolbar button.
- **Handoffs** show a card with the site origin; you do the human step and click
  Continue.
- The relay binds to `127.0.0.1` inside the container and is only exposed on
  localhost of the host. Do not publish these ports to the open internet.
- Set `OPENCODE_BROWSER_AUTO_UPDATE=off` (default in `.env.example`) to disable
  automatic relay updates inside the container.
- Browse never solves CAPTCHAs or bot challenges by itself.

### Advanced configuration

All options live in `.env` (see `.env.example` for the full annotated list):

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICE_TRANSCRIBER` | — | Whisper CLI or bundled Python wrapper (`transcribe_whisper.py`). |
| `VOICE_TRANSCRIPTION_LANGUAGE` | `auto` | Language code, or `auto` for detection. |
| `WHISPER_DAEMON_URL` | — | `http://127.0.0.1:8877` to use the persistent daemon (streaming partial transcripts). |
| `ENABLE_BROWSE` | `false` | Install/enable OpenCode Browse (real browser via extension). |
| `OPENCODE_BROWSER_AUTO_UPDATE` | `off` | Disable in-container relay auto-updates. |
| `USER_RATE_LIMIT_ENABLED` | `false` | Opt-in per-user message rate limit (off by default; monouser). |
| `AUTO_RETRY_ENABLED` | `true` | Auto-retry on rate limits (bounded). |
| `AUTO_CLEANUP_DAYS` | `0` | Archive stale OpenCode sessions (0 disables). |

Per-chat settings (via `/settings`) include `cardTheme` (`auto`/`light`/`dark`)
and `cardVerbosity` (`low`/`medium`/`high`, mapped from OpenCode 2.3.0's
transcript verbosity). The daemon enables experimental `mcp_events` so MCP
activity from Browse/Playwright is shown on the card. Enabling
`experimental.todo` in the OpenCode config adds the 📋 task checklist to the
card (opencodegram reads both `todo.updated` and `todowrite` events).

### Browse troubleshooting

- `docker compose exec opencode browse status` shows the relay, extension,
  pairing state and agent tabs.
- If the extension cannot connect, confirm ports 19988-19992 are forwarded and
  that the browser can reach `127.0.0.1` on the host.
- If pairing fails, run `browse pair` again for a fresh code.

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
