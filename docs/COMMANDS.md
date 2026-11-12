# Commands

## Sessions

- `/start`, `/help`, `/status`, `/session` — panel and active session.
- `/sessions [page]` — list and switch sessions.
- `/use [session_id]` — switch by ID; without ID shows the list.
- `/new` — create a session in a new topic (or the current topic).
- `/stop`, `/abort` — stop the active turn.
- `/retry` — re-run the last prompt (useful after rate limits).
- `/buttons` — manage custom reply buttons (admin only): list, add, remove, clear.
- `/fork`, `/rename <title>`, `/archive`, `/unarchive`, `/delete`,
  `/delete confirm`.

## Models and agents

- `/models`, `/model` — model picker, free models first, variant selection.
- `/agents`, `/agent` — agent picker.

## Settings

- `/settings` — show and toggle bot behavior per chat (with quick profiles):
  - **Mode & delivery**: `displayMode` (`unified` pinned dashboard M1 + conversation M2, or `flexible`), card behavior (`fija (edita en sitio)` / `única (borra anterior)` / `nueva (conserva anterior)`: each turn gets its own card created immediately with live streaming; `fija` keeps editing the same card), long-answer delivery (`en tarjeta` / `mensaje aparte` / `auto`) and threshold.
  - **Profiles**: `Unificado`, `Unificado+msg`, `Flexible`.
  - **Visualization**: thinking/tools/COT/latest thought & tool, token speed, partial text, compact final, session name/topic options.
  - **Shell, files, voice, resources**: shell/tool input, auto artifacts, preview lines, diff style, voice transcription, resource usage/history.
  - In unified mode, M2 streams the latest thought at the bottom and long answers can be opened in full with **`📄 Ver completo`** (or delivered as separate rich-text messages, split at markdown section boundaries).

## Operations

- `/ops` — admin-only card with runtime health: uptime, memory, disk,
  OpenCode version, Telegram 429 counters, active adaptive throttles, last
  error and all metrics counters. Buttons: `♻️ Reset métricas`,
  `🔄 Refrescar`.

## Session card

The session card (M2) keyboard offers:

- **◀ / N/M ⊞ / ▶** — page navigation; `⊞` opens a page picker grid (jump to
  any page; the picker closes itself after choosing).
- **⏭ Última** — jump back to the live page after browsing.
- **📄 Ver completo** — full final answer as message(s).
- **📜 Historial** — export the complete transcript of the session as an HTML
  document (includes content trimmed from the card pages).
- **📝 Diff (N)** — full diffs of the edits made during the turn (shown when
  the turn touched files; survives new turns and restarts).

## MCP

- `/mcp`, `/mcp list` — list MCP servers with status.
- `/mcp connect <name>` / `/mcp disconnect <name>` / `/mcp remove <name>` —
  manage servers.
- `/mcp resources` — list resources and templates.
- `/mcp read <uri>` — read a resource (HTTP/file URIs supported).

## Files and media

- Send a photo/document/audio/voice/video — attach it to the active session.
- Voice notes and audio are transcribed locally when a transcriber is configured;
  the transcript is shown and used as the prompt.
- `/file <path>` — send a local file (inside the session directory, ≤ 45 MB).
- `/ls [path] [-a]` — browse a directory with inline buttons; `-a` shows hidden
  entries and `⬆ Up` navigates to the parent. Each file has a `📄` preview and a
  `📎 Send` action that uploads it as a document.
- `/find <text> [-a]` — search names and paths recursively (skips
  `node_modules`, `.git` and build caches by default); results can also be
  previewed or sent as documents.
- `/read <path> [start_line]` — preview a UTF-8 text file with line numbers;
  binary files are sent as documents automatically.
- `/tree [path]` — show a directory tree.
- `/zip [path]` — archive a file or directory and send it as a document (≤ 45 MB;
  excludes `node_modules`, `.git`, `dist` and caches).
- `/diff` — diff summary and per-file patches.

All file commands resolve symlinks and confine the real target to the active
session directory. External symlinks are shown as `🔗` but cannot be opened.
After a turn, files reported by OpenCode are also sent automatically as
documents.

## Context and usage

- `/context` — token window, usage and recent messages.
- `/sync` — show the session digest: metadata header (model, directory,
  message/tool counts), the last 6 messages rendered in full with truncation
  hints, and older messages as a compact one-line timeline; long digests are
  split into several messages instead of being silently clamped.
- `/compact` — compact session history.
- `/usage` — global usage and cost.
- `/vcs` — branch and changed-file count.
- `/vcs diff [--cached]` — show working tree or staged diff.
- `/branches` — list branches.
- `/branch <name>` or `/branch switch <name>` — switch branch.
- `/stage <path>` — stage a file.
- `/unstage <path>` — unstage a file.
- `/commit <message>` — ask for confirmation.
- `/commit confirm <message>` — commit staged changes.
- `/worktrees` — list worktrees.
- `/worktree list|create <name> [branch]|remove <directory>|switch <directory>` —
  manage and switch worktrees.
- `/forms`, `/formreply <form_id> <json>` — pending forms and answers. Forms with
  options also get inline buttons for selecting and submitting answers.
- `/commands` — OpenCode command table plus this bot command list.
- Any other text — prompt the active session.
- Any other `/name args` — run the OpenCode command in the active session.
