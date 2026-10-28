# Sessions & History — Feature Spec

Scope for the next OpenCodegram iteration: fork, rename, archive, delete, diff, context view, and compact.

## 1. Fork session

**Command:** `/fork [title]` or button **Fork** in session panel  
**OpenCode API:** `client.session.fork({ sessionID, title? })`  
**UI:**
- Confirm dialog: "Fork current session?" with **Fork** / **Cancel**.
- On success: new session becomes active; show `Forked from <id> → <newId>`.
- Optional: create a topic if topics are enabled.

## 2. Rename session

**Command:** `/rename <new title>` or button **Rename**  
**OpenCode API:** `client.session.update({ sessionID, title })` (or rename endpoint)  
**UI:**
- If no title provided, ask with ForceReply.
- Update the active session card and topic name (if topics enabled).

## 3. Archive / Unarchive

**Command:** `/archive` / `/unarchive` or button **Archive**  
**OpenCode API:** `client.session.update({ sessionID, archived: true/false })` or dedicated archive endpoint  
**UI:**
- Archived sessions are hidden from `/sessions` by default.
- `/sessions all` includes archived (marked 🗄).
- Button toggles label between Archive / Unarchive.

## 4. Delete session

**Command:** `/delete` or button **Delete**  
**OpenCode API:** `client.session.remove({ sessionID })`  
**UI:**
- Confirmation required: "Delete session <id>? This cannot be undone."
- Buttons: **Delete** (danger) / **Cancel**.
- On success: clear active session, remove topic mapping, return to panel.

## 5. Session diff

**Command:** `/diff` or button **Diff**  
**OpenCode API:** `client.session.diff({ sessionID })` → `FileDiffInfo[]`  
**UI:**
- Show a summary: files changed, additions/deletions.
- For each file: collapsible `<details>` with unified diff in `<pre>`.
- If diff is large, send as a document or paginate.
- Buttons: **Next file**, **Prev file**, **Back**.

## 6. Context view

**Command:** `/context` or button **Context**  
**OpenCode API:** `client.session.context({ sessionID })` → `SessionMessageInfo[]`  
**UI:**
- Show recent messages (user/assistant) in a compact list.
- Truncate long messages; tap to expand.
- Show tool calls as collapsible blocks.
- Buttons: **More**, **Back**.

## 7. Compact session

**Command:** `/compact` or button **Compact**  
**OpenCode API:** `client.session.compact({ sessionID })`  
**UI:**
- Confirmation: "Compact session? This summarizes history."
- Show progress (draft/streaming) if supported.
- On success: show "Session compacted" + new token count.

## Shared UX rules

- All actions confirm destructive operations.
- Use rich HTML tables for diffs and message lists.
- Edit the same message in place for navigation (Prev/Next).
- Topics: create/reuse thread per session; delete topic mapping on delete.
- Errors are shown as `❌ <message>` with a **Panel** button.

## Implementation order

1. Rename + Fork (low risk, high value)
2. Archive / Delete (destructive; needs confirmation)
3. Diff view
4. Context view
5. Compact

## API notes

- `session.fork`, `session.update`, `session.remove`, `session.diff`, `session.context`, `session.compact` are available in `@opencode/client` 2.2.0.
- `session.update` accepts `title`, `archived`, `metadata`.
- Diffs can be large; chunk or send as file.
- Context view should respect `message_thread_id` for topics.
EOF