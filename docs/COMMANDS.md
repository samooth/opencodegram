# Commands

## Sessions

- `/start`, `/help`, `/status`, `/session` — panel and active session.
- `/sessions [page]` — list and switch sessions.
- `/use [session_id]` — switch by ID; without ID shows the list.
- `/new` — create a session in a new topic (or the current topic).
- `/stop`, `/abort` — stop the active turn.
- `/fork`, `/rename <title>`, `/archive`, `/unarchive`, `/delete`,
  `/delete confirm`.

## Models and agents

- `/models`, `/model` — model picker, free models first, variant selection.
- `/agents`, `/agent` — agent picker.

## Files and media

- Send a photo/document/audio/voice/video — attach it to the active session.
- `/file <path>` — send a local file (inside the session directory, ≤ 45 MB).
- `/ls [path] [-a]` — browse a directory with inline buttons; `-a` shows hidden
  entries and `⬆ Up` navigates to the parent.
- `/find <text> [-a]` — search names and paths recursively (skips
  `node_modules`, `.git` and build caches by default).
- `/read <path> [start_line]` — preview a UTF-8 text file with line numbers;
  binary and oversized previews are rejected.
- `/diff` — diff summary and per-file patches.

All file commands resolve symlinks and confine the real target to the active
session directory. External symlinks are shown as `🔗` but cannot be opened.

## Context and usage

- `/context` — token window, usage and recent messages.
- `/sync` — replay the last messages into Telegram.
- `/compact` — compact session history.
- `/usage` — global usage and cost.
- `/vcs` — branch and changed-file count.
- `/worktrees` — list worktrees.
- `/forms`, `/formreply <form_id> <json>` — pending forms and answers.
- `/commands` — OpenCode command table plus this bot command list.
- Any other text — prompt the active session.
- Any other `/name args` — run the OpenCode command in the active session.
