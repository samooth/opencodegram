# Architecture

- Telegram bot (long polling or webhook)
- OpenCode client over HTTP/events
- Shared core: session actors, renderer, rate limiter, SQLite store (planned)
- Daemon for production; embedded mode for zero-config
EOF