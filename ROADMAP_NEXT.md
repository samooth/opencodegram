# Roadmap

## Done

- Per-topic session isolation with persisted tab bindings (`data/active.json`).
- Modular daemon: store, sessions, status, panels, events, commands, callbacks,
  messages, updates and Telegram/OpenCode bridges.
- Rich status card: thinking, tool calls, Stop button, final answer, tok/s.
- Model and variant picker (free models first), agent picker.
- Permission approvals, including reject-with-reason.
- Multimedia ingestion (photo/document/audio/voice/video) with vision auto-switch.
- Outbound documents via `sendDocument` and `/file`.
- Safe file browser: `/ls`, `/find`, `/read`, inline navigation, pagination,
  hidden-file toggle, symlink confinement and text preview limits.
- `/zip` archives and automatic delivery of files produced by a turn.
- Local voice-note transcription with configurable Whisper-compatible CLI.
- Worktree management: list, create, remove and switch the active session.
- VCS actions: branch switching, staging/unstaging and commits with confirmation.
- MCP status: list, connect, disconnect, remove servers and browse resources.
- Operations: health endpoint, metrics, audit log rotation and disk guard.
- Automated Bun tests for routing/tab isolation, path guard, `/file`, file
  browser, transcription, rate-limit retry and command parsing (`bun test`).
- `/vcs` status, `/worktrees` listing, `/forms` + `/formreply`.
- `/sync` history replay, `/context`, `/usage`, `/diff`, `/compact`.
- Rate-limit retry at `:15` of the next hour.
- Audit log (`data/audit.log`) and per-update error isolation.
- Webhook mode (optional) with secret validation; long polling remains default.
- Update offset persistence and update dedup to avoid replayed prompts.
- Bounded auto-retry (max attempts, stale-prompt guard); /retry falls back to
  the most recent session in the chat.
- Per-turn prompt persistence (`data/turnPrompts.json`) for dataset exports.
- Export formats: HTML (safe Markdown rendering), Markdown, JSON-LD and JSONL.
- Per-session transcript persistence (`data/transcripts/`), pagination cache and
  attachment cleanup with TTL.
- Voice transcription via a bundled HuggingFace Whisper wrapper with automatic
  language detection.
- Graceful handling of Telegram 429 (`retry_after`), 502 outages and 409
  conflict on restart.
- Group media policy: photos/documents require an explicit mention; voice notes
  also work as a reply to the bot.
- Adaptive per-chat throttle, enriched `/ops` health (throttles + GPU).
- OpenCode 2.3.0 in Docker: background subagents and fork/subagent badges, MCP
  events, quieter transcripts (card verbosity setting).
- Compact activity summary on the card (`+3 thoughts · 3 reads · 1 tool`),
  expandable in place via native Telegram blockquote — no extra messages.
- Browser tooling: optional OpenCode Browse (real browser via extension) and
  always-on Playwright MCP (headless Chromium for web debugging).
- Streaming transcription (SSE) with partial text published to the card.
- Card theme (auto/light/dark), card verbosity and read-text LRU cache.
- `/todos`, `/unlink`, `/cancel` commands; per-user rate limiting opt-in via env.
- Code quality: zero `any` in `src`, structured logging, unified save/load
  helpers, no silent `answerCallbackQuery` failures.

## Next

1. **Multi-user roles** – viewer/operator/admin ACLs, approver groups, audit UI.
2. **Mini App** – diffs, file tree and approvals in a richer Telegram WebApp.
3. **Automatic session summary** – generate a short topic title from the turn
   result.
4. **`/retry` with turn selection** – replay a specific past turn.
5. **`/search` over user prompts** – currently only answer blocks are searched.
6. **Graceful degradation when OpenCode is down** – notify and retry instead of hanging.

## Suggested order

The file browser, artifacts, voice notes (including streaming), MCP status,
worktrees, VCS actions and browser tooling are shipped. Next: automatic
summaries, `/retry` turn picker and prompt search.
