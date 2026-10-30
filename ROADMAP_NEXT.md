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
- Automated Bun tests for routing/tab isolation, path guard, `/file`, file
  browser, transcription, rate-limit retry and command parsing (`bun test`).
- `/vcs` status, `/worktrees` listing, `/forms` + `/formreply`.
- `/sync` history replay, `/context`, `/usage`, `/diff`, `/compact`.
- Rate-limit retry at `:15` of the next hour.
- Audit log (`data/audit.log`) and per-update error isolation.

## Next

1. **MCP status** – list servers, connect/disconnect, show resources and read
   them from Telegram.
2. **Webhook mode** – optional production mode with secret validation; keep
   long polling as the default.
3. **Multi-user roles** – viewer/operator/admin ACLs, approver groups, audit UI.
4. **Mini App** – diffs, file tree and approvals in a richer Telegram WebApp.
5. **Operations** – health endpoint, metrics, log rotation, disk guard.

## Suggested order

Tests, the file browser and artifacts are shipped. Next, voice notes or MCP
status (still pending), then worktrees and VCS actions.
