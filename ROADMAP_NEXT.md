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
- `/vcs` status, `/worktrees` listing, `/forms` + `/formreply`.
- `/sync` history replay, `/context`, `/usage`, `/diff`, `/compact`.
- Rate-limit retry at `:15` of the next hour.
- Audit log (`data/audit.log`) and per-update error isolation.

## Next

1. **Automated tests** – Bun tests for routing, tab isolation, path guard,
   rate-limit retry and command parsing; smoke test with a fake OpenCode server.
2. **File browser & artifacts** – `/ls`, `/find`, `/read`, `/zip`, artifact
   delivery after a turn, safe path confinement and pagination.
3. **MCP status** – list servers, connect/disconnect, show resources and read
   them from Telegram.
4. **Voice notes** – transcribe locally (whisper.cpp or available CLI) and prompt
   the active session with the transcript.
5. **Worktrees management** – create/remove/switch worktrees, not just list.
6. **VCS actions** – switch branch, stage/unstage, commit with confirmation.
7. **Webhook mode** – optional production mode with secret validation; keep
   long polling as the default.
8. **Multi-user roles** – viewer/operator/admin ACLs, approver groups, audit UI.
9. **Mini App** – diffs, file tree and approvals in a richer Telegram WebApp.
10. **Operations** – health endpoint, metrics, log rotation, disk guard.

## Suggested order

Ship **tests + file browser** first: they protect the session routing we just
stabilized and make every later feature easier to verify. Then MCP, voice and
the remaining control actions.
