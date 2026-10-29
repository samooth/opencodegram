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
- Automated Bun tests for routing/tab isolation, path guard, `/file`, file
  browser, rate-limit retry and command parsing (`bun test`).
- `/vcs` status, `/worktrees` listing, `/forms` + `/formreply`.
- `/sync` history replay, `/context`, `/usage`, `/diff`, `/compact`.
- Rate-limit retry at `:15` of the next hour.
- Audit log (`data/audit.log`) and per-update error isolation.

## Next

1. **Artifacts & archives** – `/zip` for directories, artifact delivery after a
   turn, and cleanup of oversized previews.
2. **MCP status** – list servers, connect/disconnect, show resources and read
   them from Telegram.
3. **Voice notes** – transcribe locally (whisper.cpp or available CLI) and prompt
   the active session with the transcript.
4. **Worktrees management** – create/remove/switch worktrees, not just list.
5. **VCS actions** – switch branch, stage/unstage, commit with confirmation.
6. **Webhook mode** – optional production mode with secret validation; keep
   long polling as the default.
7. **Multi-user roles** – viewer/operator/admin ACLs, approver groups, audit UI.
8. **Mini App** – diffs, file tree and approvals in a richer Telegram WebApp.
9. **Operations** – health endpoint, metrics, log rotation, disk guard.

## Suggested order

Tests and the file browser are shipped. Next, add artifacts/`/zip` (reuses the
same path guard), then MCP, voice and the remaining control actions.
