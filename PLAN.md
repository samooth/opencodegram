# OpenCode × Telegram — Control Plane Plan

> **Status:** proposal v1.1 · decisions confirmed 2026-10-28  
> **Targets:** OpenCode 2.2.x, `@opencode/plugin` 2.2.x, Telegram Bot API 10.3  
> **Name:** `opencodegram`

**The short version:** build a **hybrid plugin package**. The core is a TypeScript bot runtime that talks to OpenCode over its HTTP and event APIs. A thin OpenCode **server plugin** adds remote-safety policy, pairing/status RPC, and an optional embedded host. A **TUI companion** makes pairing and status feel native. The primary UX is a **private Telegram chat with forum topics enabled — one topic per session** — using Bot API 10.3 **rich messages** and **streaming drafts**. Production runs the bot as a daemon; embedded mode is the zero-config on-ramp.

This is not a bot that forwards text. It is a **remote control plane** for OpenCode: live sessions, one-tap approvals, diffs, files, models, agents, and costs, with the conversation as the interface.

---

## 1. What I propose

1. **Ship one package with three parts**
   - `./server` — OpenCode plugin: remote-safety policy, pairing/status RPC, optional embedded bot host.
   - `./tui` — TUI companion: `/telegram` command, pairing code, connection badge, pending approvals.
   - `./cli` — daemon: `opencodegram serve`, pairing, health, migrations.

2. **Use one shared core**
   - Telegram transport, session actors, renderer, rate limiter, SQLite store, auth, audit.
   - The plugin host and daemon host are adapters over the same core, so embedded mode can graduate to daemon mode without a rewrite.

3. **Make private-chat topics the default**
   - Telegram now supports **forum topics in a bot's private chat** (`getMe.has_topics_enabled`, `createForumTopic` works there).
   - One topic per OpenCode session gives each session its own thread, unread state, mute state, and pinned control panel.
   - Fallbacks: supergroup with topics (teams), or compact single-chat mode (trial/old clients).

4. **Design for Telegram 10.3, not 2019**
   - **Rich messages** (`sendRichMessage`, `editMessageText.rich_message`) give us tables, headings, lists, collapsible `<details>`, code blocks, math, and in-message buttons.
   - **Rich drafts** (`sendRichMessageDraft`) stream partial output in private chats, animate in place, and can show a native **Stop** button (`can_stop`, `stopped_message_generation`).
   - **Ephemeral messages** in groups can show approval cards only to the approver.
   - Legacy HTML messages remain the fallback.

5. **Treat permissions as the killer feature**
   - Every approval is a card: action, exact resource, risk, requester, expiry, and what “Always” will save.
   - Buttons: **Allow once**, **Always allow** (admin only), **Reject**, **Reject with reason**.
   - Auto-reject on timeout; update the card if the TUI answers first; audit every decision.
   - A server-side **remote-safety policy** can escalate `allow` to `ask` for shell/edit/external-directory actions in Telegram-originated sessions. Telegram never bypasses OpenCode permissions.

6. **Be honest about the host**
   - Embedded mode is great for one project and quick starts.
   - A daemon is the right production host: independent restarts, multi-project, SQLite, health checks, metrics, no single-`getUpdates` conflicts.
   - The plugin remains valuable in daemon mode: policy, RPC, and TUI integration.

**Effort:** ~7–10 weeks for one senior TypeScript developer, with a usable MVP in ~2.5–3 weeks. With two developers, ~4–6 weeks to a polished beta.

---

## 2. Goals, non-goals, and success criteria

### 2.1 Goals

| Goal | What it means |
|---|---|
| **Full remote control** | Create, switch, prompt, stop, fork, rename, archive, and delete sessions; switch models/agents; run commands; approve permissions; answer forms; inspect diffs, files, usage, and MCP status. |
| **A genuinely great UI** | Native-feeling Telegram surfaces: one topic per session, a live control panel, streaming drafts, collapsible activity, tappable approvals, sensible pagination, no message floods. |
| **Safe by default** | Pairing, allowlists, roles, approval expiry, audit trail, secrets never rendered, remote sessions stricter than local ones. |
| **Reliable** | Survives OpenCode restarts, Telegram 429s, network flaps, duplicate updates, and missed events. |
| **Low operational cost** | One binary/process (daemon) or zero extra process (embedded), SQLite, Docker/systemd, health endpoint. |
| **Composable** | Core is usable from a future web UI, Mini App, CLI, or another chat transport. |

### 2.2 Non-goals for v1

- Replacing the TUI. The TUI remains the best place for deep code review and terminal work.
- A full code editor in Telegram. We show diffs, send files, and let you approve edits; we do not edit code in chat.
- A public multi-tenant bot. This is a personal/team control plane, not a SaaS.
- Arbitrary shell/PTY access by default. Optional, admin-only, explicitly confirmed.
- Real-time voice conversation. Voice messages → transcript → prompt is in scope; live voice is a later experiment.
- Provider/credential management (OAuth flows, API keys) is view-only in v1; do it in the TUI/Console.
- A Telegram Mini App in v1. Rich messages cover the core; a Mini App is a Phase 5 option.

### 2.3 Success criteria

| Stage | Criteria |
|---|---|
| **MVP** | Pair from TUI; create/switch session; send text; watch live output; stop; switch model/agent; approve/deny a permission; see a final answer; recover after a bot restart. |
| **Beta** | Private topics; pinned control panel; rich tables/details; diffs; file upload/download; forms; notifications; multi-session navigation; 429-safe under load. |
| **Great** | <2.5 s median time-to-first-visible-token; <1 s permission delivery; zero unauthorized actions in security tests; no message floods in a 50-session soak; 99.5% control-plane availability. |

### 2.4 Design principles

1. **Chat is a control surface, not a transcript.** Edit one message per concept instead of appending a log.
2. **One concept, one message.** Control panel, answer, activity, approval, diff, form — each has a stable message identity.
3. **Progressive disclosure.** Summary first; `<details>` for tool input/output, reasoning, and long diffs.
4. **Buttons for actions, text for intent.** Anything deterministic is a button; text is only for prompts, search, and free-form answers.
5. **Quiet by default.** Progress edits are silent; only completion, errors, and approvals notify.
6. **Never lose the user.** Every screen has Back/Home; every destructive action confirms; every timeout explains itself.
7. **Safe by default.** Deny by default on timeout; “Always” is privileged; shell/PTY are opt-in.
8. **Degrade gracefully.** Rich → legacy HTML → plain text; topics → compact; drafts → edits.

---

## 3. Why a hybrid plugin, not a pure plugin

### 3.1 What the OpenCode plugin API gives us

The V2 server plugin runs inside the OpenCode server and exposes:

- `ctx.event.subscribe({ types, signal })` — the public event stream, including `session.text.delta`, `session.tool.*`, `permission.asked`, `form.created`, `session.status`, and more.
- `ctx.session.*` — create/list/get/prompt/interrupt/switchModel/switchAgent/update/compact/context.
- `ctx.permission.*` — list/get/reply, and the `evaluate` hook.
- `ctx.session.hook("prompt", ...)` — inspect/transform admitted prompts.
- `ctx.vcs.*`, `ctx.tool.*`, `ctx.command.*`, `ctx.skill.*`, `ctx.mcp.*`, `ctx.storage.*`, `ctx.rpc.*`.
- `ctx.location` — the location where this plugin instance is loaded.
- `setup(ctx)` returning a cleanup function; config reloads without restarting OpenCode.

That is enough to build a bot. But there are real constraints:

| Constraint | Consequence |
|---|---|
| `setup` is tied to a **location** and plugin lifecycle. | A global plugin may load once per active location; a bot per instance would fight over the same token. |
| Telegram allows **one `getUpdates` consumer per bot token**. | Multiple OpenCode servers/locations cannot each long-poll the same token. |
| The bot is a **long-running network service**. | You want independent restarts, health checks, and logs, not a side effect of the agent server. |
| Plugin storage is JSON key-value. | History, audit, queues, and message maps want SQLite. |
| The plugin context does not expose every route (forms are a notable gap). | The daemon can use the full `@opencode/client` HTTP surface. |
| Bot API cannot fetch chat history. | The bot must persist message IDs and state; a restart needs reconciliation. |

### 3.2 Options considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Pure embedded plugin** | Zero extra process; direct `ctx`; hooks; RPC; simplest install | Lifecycle coupling; multi-location/token conflicts; harder ops; limited storage; server restart drops the bot | Good for a demo, not daily driver |
| **B. Pure daemon** | Reliable; multi-project; SQLite; independent deploy; metrics; no token conflict | Extra process; needs server URL/auth; no direct hooks; pairing UX has to be built | Strong production host |
| **C. Hybrid (chosen)** | Daemon reliability + plugin policy/RPC/TUI + zero-config embedded mode | Two hosts to maintain; needs a shared core and clear mode rules | **Recommended** |

### 3.3 Chosen architecture

```text
┌──────────────────────────────┐
│ Telegram                     │
│ private chat + topics        │
│ or supergroup + topics       │
└──────────────┬───────────────┘
               │ Bot API 10.3 (long poll or webhook)
┌──────────────▼───────────────┐
│ opencodegram daemon     │
│                              │
│  grammY / typed Bot API      │
│  session actors              │
│  rich renderer               │
│  rate limiter + outbox       │
│  SQLite (state/audit)        │
│  admin API (127.0.0.1)       │
└──────────────┬───────────────┘
               │ HTTP + SSE (@opencode/client)
┌──────────────▼───────────────┐
│ OpenCode server              │
│                              │
│  sessions / tools / VCS      │
│  permissions / forms         │
│  event stream                │
│  ┌────────────────────────┐  │
│  │ opencodegram      │  │
│  │ server plugin          │  │
│  │ • remote-safety policy │  │
│  │ • pairing/status RPC   │  │
│  │ • optional embedded bot│  │
│  └────────────────────────┘  │
└──────────────┬───────────────┘
               │
        workspace / shell / MCP
```

**Rule of thumb:** the daemon owns the bot; the plugin owns policy and integration. Embedded mode is a convenience host for the same core, not a second implementation. If you want the literal one-line install, `host: "embedded"` runs the bot inside the OpenCode plugin; you can start there and move to the daemon later without changing the Telegram UX, config schema, or state model.

---

## 4. The Telegram UX

### 4.1 Three operating modes

| Mode | Chat shape | Best for | Session mapping | Streaming |
|---|---|---|---|---|
| **Private topics** (default) | DM with the bot, forum topics enabled | Solo power user | One topic per session; a **Home** topic for workspace/control | Rich drafts + final rich message |
| **Supergroup** | Supergroup with topics; bot is admin with “Manage Topics” | Teams, shared visibility | One topic per session; General = control room | Placeholder + `editMessageText` rich edits |
| **Compact** | Single DM, no topics | Trial, older clients, quick use | One active session per user; switcher | Rich drafts + final rich message |

Private topics is the sweet spot: it gives the organizational benefits of a forum without creating a group or inviting anyone. If the bot reports `has_topics_enabled = false`, onboarding offers “Enable topics in @BotFather” and falls back to compact mode.

### 4.2 Information architecture

| OpenCode concept | Telegram surface |
|---|---|
| Project / location | Workspace card; Home topic; supergroup per project in team mode |
| Session | Forum topic; title = `project · session title` |
| Turn | A cluster: control panel + answer + activity card |
| Assistant text segment | One rich message (streamed via draft while live) |
| Tool call | A row inside a collapsible `<details>` activity card |
| Permission request | Standalone approval card with inline keyboard |
| Form | One wizard card, one field at a time or inline toggles |
| Diff | Diff card + downloadable `.diff` file |
| Notification | Home/control room; per-topic mute respected |
| Cost/usage | Control panel footer + `/usage` |

Topic names are capped at 128 characters; truncate with an ellipsis and keep the full title in the control panel. Rename the topic when the session title changes, but never let a title rename move the topic.

Navigation map:

```text
Home
├── Sessions ──► Session topic ──► Activity details
│                 ├── Model picker
│                 ├── Agent picker
│                 ├── Diff / files
│                 └── Revert / fork / archive
├── Workspaces / projects
├── Usage & limits
├── Pending approvals
└── Settings
```

### 4.3 The control panel

Every session topic gets one **pinned** control panel message (or `/status` if pinning is unavailable). It is edited in place, never appended.

```text
📌 Fix auth refresh
🟢 running · build · claude-sonnet-5-5
Step 3 · 12.4k in / 1.8k out · $0.08 · 00:42
main · 4 files changed · 1 approval pending

[⏹ Stop] [🧠 Model] [🤖 Agent] [⋯ More]
```

Rules:

- Status icon set: `⚪ idle`, `🟢 running`, `🟡 retry/waiting`, `🔴 failed`, `⏸ interrupted`.
- The panel is updated on `session.status`, `session.step.*`, `session.usage.updated`, `session.execution.*`, and `vcs.branch.updated`.
- Throttle panel edits to one per 3 s; always flush on a state transition (start, finish, error, approval).
- “More” opens a second card: fork, rename, compact, revert, export, mute, archive, delete.

### 4.4 A live turn

```text
You
Fix the refresh-token race in the auth client. Add a regression test.

OpenCode · working
▸ Thinking…  (rich draft, animated; native Stop button)

OpenCode
The race is in `refresh.ts`: two concurrent 401s both call
`refresh()` before the first rotation is persisted.

▸ Activity · 4 tools · 12s                    [expand]
   ✓ read   src/auth/refresh.ts              0.2s
   ✓ grep   "refreshToken"                    0.1s
   ✓ edit   src/auth/refresh.ts              1.8s
   ✓ shell  npm test -- --runInBand          9.4s

──────────────────────────────────────────────
✓ done · 42s · 18.2k tok · $0.11 · 2 files
[Continue] [Retry] [Diff] [Fork] [New session]
```

Sequence:

1. User message is echoed as a compact “You” card (quoted text, attachments, source).
2. On `session.execution.started`, create the turn actor and show a thinking draft.
3. On `session.text.delta`, append to the draft buffer and stream at most every ~1.2 s.
4. On `session.tool.called/success/failed`, update the activity card; do not send a message per tool.
5. On `session.text.ended`, finalize the segment with the exact text.
6. On `session.step.ended`, update tokens/cost/files.
7. On `session.execution.succeeded`, send the final rich message, add action buttons, and mark the OpenCode session viewed (`POST /api/session/{id}/view`).
8. On `session.idle`, clear the typing indicator and panel state.

If a turn produces multiple assistant segments (tool loop), each gets its own final message; activity is grouped per turn.

**Message budget:** a normal turn is 1 user echo + 1 live answer (drafted/edited) + 1 activity card (edited) + 1 final card. A permission adds 1 card. Never send one message per tool call; that is the fastest way to make the bot feel like a log file.

### 4.5 Streaming: drafts vs edits

Telegram 10.3 changed what “streaming” can mean:

| Surface | Technique | Notes |
|---|---|---|
| Private chat (with or without topics) | `sendRichMessageDraft` with a stable `draft_id` | Ephemeral 30 s preview; animated in place; `can_stop: true`; final output must be sent with `sendRichMessage` |
| Supergroup topic | `sendRichMessage` placeholder, then `editMessageText` with `rich_message` | No drafts in groups; throttle edits |
| Legacy fallback | `sendMessage` placeholder, then `editMessageText` HTML | 4,096-char limit; split long output |

Draft lifecycle:

- Send a draft as soon as generation starts: `<tg-thinking>Thinking…</tg-thinking>`.
- Keep the same `draft_id` for the turn; changes animate instead of replacing.
- Refresh at least every 10 s even if the text has not changed (the draft expires after ~30 s).
- `can_stop: true`; `keep_on_stop: true` so the partial text remains while the interrupt propagates.
- On `stopped_message_generation`, call `session.interrupt`, mark the turn “stopped by user,” and send the partial text as a real message with a “Stopped” footer.
- On completion, send the final rich message. Sending a message clears the draft.
- If the final message is too large, split at block boundaries; attach the full transcript as `.md`.

Group edits:

- One placeholder per assistant segment.
- Minimum interval 1.2–1.5 s; coalesce deltas; only edit when the rendered text changed materially (e.g., >24 chars or a new block).
- Add an inline **Stop** button to the placeholder; remove it on finalize.
- On 429, honor `retry_after`, pause that chat, and let the buffer grow; do not drop the final text.

### 4.6 Permissions

Approval card:

```text
🔐 Approval needed · shell
Risk: medium · requested by build · expires in 9:41

npm test -- --runInBand
in /path/to/opencodegram

Why: run the regression suite after editing refresh.ts

[✅ Allow once] [♾️ Always allow]
[⛔ Reject]     [💬 Reject with reason]
```

Rules:

- **Allow once** → `decision: "once"`.
- **Always allow** → `decision: "always"`; show exactly which patterns will be saved (`request.save`), and require an admin/approver role. “Always” is durable and project-scoped.
- **Reject** → `decision: "reject"`; note that OpenCode rejects **all pending requests in that session**, so the UI says “Reject all pending in this session.”
- **Reject with reason** → force-reply, then reject with `message`; the model sees the reason.
- Timeout (default 10 min) → auto-reject with a message, edit the card to “Expired,” and notify the TUI.
- If the TUI or another client answers first, `permission.replied` updates the card: “Approved in TUI by …”.
- Only paired approvers can press. Everyone else gets a callback toast: “Not authorized.”
- In a supergroup, send the sensitive card as an **ephemeral message** to the chosen approver (`ephemeral_message_parameters.receiver_user_id`) plus a one-line public “Approval requested” notice. If ephemeral delivery fails, fall back to the normal card. Treat ephemeral approvals as experimental until they pass the security tests.
- Every decision is audited: request ID, session, action, resources, user, decision, timestamp.
- The bot never auto-approves. Configured `deny` rules remain final.

**Remote-safety policy (plugin):** sessions prompted from Telegram are tagged in `session.prompt.metadata`. A server-side `permission.hook("evaluate")` escalates `allow` → `ask` for `shell`, `edit`, and `external_directory` in those sessions, unless an explicit rule already allows them. This means a Telegram user cannot accidentally inherit a permissive local policy.

### 4.7 Forms and questions

OpenCode forms arrive as `form.created` with typed fields. Telegram has no modal form, so use a **wizard card**:

```text
📋 Deploy target · 1/3

Environment
[staging] [production] [custom…]

Region
[eu-west-1] [us-east-1]

[Back] [Next] [Cancel]
```

Field mapping:

| OpenCode field | Telegram control |
|---|---|
| `string` with `options` | Inline buttons; `custom: true` adds “Other…” → force reply |
| `string` free-form | Force reply; validate `minLength`, `maxLength`, `pattern`, `format` |
| `number` / `integer` | Force reply + numeric validation |
| `boolean` | Yes / No buttons |
| `multiselect` | Toggle buttons + Done; enforce `minItems`/`maxItems` |
| `external` | Link/instructions + “I’m done” button; never fake completion |
| `when` conditions | Evaluate after each answer; hide/skip irrelevant fields |

The card shows progress (`1/3`), current values, validation errors, and a final **Submit** button. On submit: `POST /api/session/{sessionID}/form/{formID}/reply` with `answer`. On cancel: cancel the form with an optional message. If another client answers, `form.replied` closes the wizard.

MVP can support boolean/options/free-text; multiselect and conditional fields are Phase 2.

### 4.8 Diffs, files, and artifacts

Diff card:

```text
📝 4 files changed · +128 −37

src/auth/refresh.ts      +82 −21
src/auth/session.ts      +31 −10
test/auth.test.ts        +15 −6
package.json              +0 −0

[Working tree] [Branch vs base] [Last turn]
[👀 Preview diff] [📎 Download .diff] [↩️ Revert turn]
```

- `Preview diff` sends a rich card with one `<details>` per file and a `<pre><code class="language-diff">` block. Cap at ~200 lines/file; attach the rest.
- `Download .diff` uses `sendDocument`.
- `Revert turn` stages a revert, shows exactly what will change, and requires confirmation; then commit or clear.
- File paths and commands get `copy_text` buttons where useful.

Files:

- `/files [path]` shows a table of entries (name, type, size, modified) with navigation buttons.
- File actions: **Send**, **Preview** (first 4 KB), **Add to prompt**, **Copy path**.
- Uploads are quarantined, size/type checked, and never overwritten without confirmation. Reject path traversal and symlink escapes.
- Photos/screenshots can be sent straight into the prompt as file attachments; documents can be “save to workspace” or “attach to prompt.”

Artifacts:

- Generated images/files are sent as photos/documents, or as `<tg-document>`/`<figure>` in rich messages when hosted over HTTPS.
- Prefer uploading to Telegram over remote hotlinks: remote media leaks the viewer’s IP and can break.

### 4.9 Commands and pickers

Telegram command menu (max 100; lowercase `a-z0-9_`):

| Command | Action |
|---|---|
| `/start`, `/help` | Onboarding / contextual help |
| `/pair` | Pair this chat with the daemon/TUI |
| `/home` | Workspace control room |
| `/sessions` | Paginated session list |
| `/new [title]` | Create session (auto-title if omitted) |
| `/switch` | Session picker |
| `/status` | Control panel for the active session |
| `/stop`, `/abort` | Interrupt |
| `/model`, `/agent`, `/variant` | Pickers |
| `/compact` | Compact context |
| `/rename`, `/fork`, `/archive`, `/delete` | Session lifecycle |
| `/export [md\|json]` | Export session transcript |
| `/diff` | Working/branch/last-turn diff |
| `/files [path]` | File browser |
| `/send <path>` | Send a file |
| `/revert` | Stage/commit/clear a revert |
| `/commands` | OpenCode commands |
| `/skills` | Skills list/activate |
| `/mcp` | MCP status; connect/disconnect where safe |
| `/usage` | Cost/tokens/limits |
| `/quiet`, `/verbose` | Notification/streaming verbosity |
| `/settings` | Inline settings |
| `/whoami` | Role and chat binding |

Pickers:

- Models: recent first, then provider groups; show context window, cost tier, capabilities; variants as a second step.
- Agents: name, description, mode; current highlighted.
- Commands: OpenCode commands from `ctx.command.list()`, invoked via `session.command`.
- Sessions: 8 per page, status icon, relative time, model, cost; buttons open the topic (or switch active in compact mode). `/sessions <query>` filters by title; there is no message-history search because Bot API cannot read chat history.

### 4.10 Input types

| Input | Handling |
|---|---|
| **Text** | Prompt to the active/topic session; in groups, require `/ask` or a reply to the bot if privacy mode hides plain messages |
| **Reply / quote** | Prefix the prompt with a quoted context block; preserve source metadata |
| **Photo** | Download largest size; attach as `file://…`; caption becomes text |
| **Document** | Download, validate size/type, quarantine; offer “attach” vs “save to workspace” |
| **Voice** | Download OGG; transcribe (local `whisper.cpp` by default, optional API); show transcript with Send/Edit/Cancel |
| **Album** | Debounce by `media_group_id` (~1 s); attach all files to one prompt |
| **Forwarded** | Extract text/media; mark as forwarded in metadata; treat as untrusted content |
| **Edited message** | If the prompt is still queued, offer “Update queued prompt”; otherwise explain that it was already delivered |

### 4.11 Notifications

- Progress edits: `disable_notification: true`.
- Completion/error/approval: normal notification.
- Per-topic mute is respected by Telegram; the bot also has `/quiet`.
- **Home** topic (or General in a supergroup) shows: active sessions, pending approvals, today’s cost, and a daily digest.
- Optional: pin a “Waiting for you” message when approvals exceed a threshold.

### 4.12 Onboarding and pairing

1. User creates a bot with @BotFather, enables **Topics in Private Chats** if offered, sets privacy mode, description, and commands.
2. User runs `/start`; the bot replies with a welcome card and a **Pair** button.
3. Pairing code is generated in the TUI (`/telegram pair`) or CLI (`opencodegram pair`): 8 chars, 10 min TTL, single use, stored hashed.
4. Deep link: `https://t.me/<bot>?start=<code>`.
5. On redemption: bind Telegram user ID + chat ID, assign role (owner for the first user), choose mode (private topics / supergroup / compact), link a workspace/project.
6. Capability check via `getMe`: `has_topics_enabled`, `can_read_all_group_messages`, `can_join_groups`. Show a setup checklist with fixes.
7. Send a test card: “Connected to OpenCode 2.2.0 · project · branch.”

Supergroup setup: user creates the group, adds the bot as admin with **Manage Topics**, runs `/bind`, and optionally sets `allowedUserIds`.

Capability matrix:

| Capability | Detection | Fallback |
|---|---|---|
| Private-chat topics | `getMe.has_topics_enabled` | compact mode or supergroup |
| Plain group messages | `getMe.can_read_all_group_messages` | `/ask` or reply to the bot |
| Rich messages | Bot API 10.1+; downgrade on 400 | legacy HTML (4,096 chars) |
| Rich drafts | Bot API 10.1+; private chat only | placeholder + edits |
| Ephemeral approval cards | group + Bot API 10.3+ (rich) | normal approval card |
| Native draft Stop | `can_stop` supported | inline Stop button |

### 4.13 UI grammar

- **Status**: `⚪ idle`, `🟢 running`, `🟡 retry`, `🔴 failed`, `⏸ interrupted`, `✅ done`.
- **Keyboard layout**: primary action left, destructive right; max 3–4 buttons per row; always a way back.
- **Pagination**: `[‹ Prev] [1/3] [Next ›]`, 8 items per page.
- **Empty states**: explain the next action, not just “nothing here.”
- **Errors**: what happened, what it means, and three actions: Retry, Switch model, Show details.
- **Copy**: short, specific, no raw stack traces in the main card; logs behind “Details.”
- **Accessibility**: never rely on color alone; include text status; keep code blocks readable; avoid tiny button labels.
- **Localization**: English first, but keep all copy in message catalogs; `is_rtl` is supported by rich messages.
- **Visual identity**: name the bot “OpenCode”; set the avatar in @BotFather; use a static topic icon color per project, not per status (renaming topics on every status change is noisy); use `<tg-time>` for timestamps and `<tg-reference>` for footnotes; keep the emoji set small and consistent.
- **Timestamps**: show relative time in lists (“2m ago”) and absolute time in tooltips/cards (`<tg-time unix=…>`).

---

## 5. Technical architecture

### 5.1 Package layout

```text
opencodegram/
├── package.json                 # exports: ., ./server, ./tui, ./rpc, ./cli
├── src/
│  ├── index.ts                  # Plugin.define (server part)
│  ├── rpc.ts                    # typed RPC contract
│  ├── tui.tsx                   # TUI companion
│  ├── cli.ts                    # daemon entry + pairing
│  ├── core/
│  │  ├── config.ts              # schema + env interpolation
│  │  ├── logger.ts              # pino, redaction
│  │  ├── errors.ts              # typed error taxonomy
│  │  └── clock.ts               # injectable clock for tests
│  ├── opencode/
│  │  ├── adapter.ts             # interface over plugin ctx / @opencode/client
│  │  ├── plugin-adapter.ts
│  │  ├── client-adapter.ts
│  │  ├── events.ts              # normalization + ordering
│  │  └── reconcile.ts           # reconnect/resync
│  ├── host/
│  │  ├── embedded.ts            # bot inside the OpenCode plugin
│  │  └── daemon.ts              # standalone bot process
│  ├── telegram/
│  │  ├── api.ts                 # typed Bot API, rich methods, raw updates
│  │  ├── bot.ts                 # grammY wiring / update router
│  │  ├── auth.ts                # pairing, roles, callback validation
│  │  ├── outbox.ts              # priority queue, idempotency, retry
│  │  ├── rate-limit.ts          # per-chat + global token buckets
│  │  ├── topics.ts              # create/rename/close/reopen
│  │  └── files.ts               # download/upload, quarantine
│  ├── render/
│  │  ├── markdown.ts            # MDAST → rich HTML
│  │  ├── rich.ts                # rich message builders
│  │  ├── legacy.ts              # 4096-char HTML fallback
│  │  ├── chunk.ts               # block-aware splitting
│  │  ├── sanitize.ts            # whitelist + escaping
│  │  └── templates/             # panels, approvals, diffs, forms
│  ├── session/
│  │  ├── actor.ts               # per-session serialized state machine
│  │  ├── turn.ts                # turn buffer + view model
│  │  ├── activity.ts            # tool call aggregation
│  │  ├── permissions.ts
│  │  └── forms.ts
│  ├── store/
│  │  ├── db.ts                  # SQLite + migrations
│  │  ├── repositories.ts
│  │  └── plugin-storage.ts      # embedded fallback via ctx.storage
│  ├── admin/
│  │  ├── server.ts              # 127.0.0.1 admin API
│  │  └── auth.ts
│  └── security/
│     ├── policy.ts              # remote-safety policy
│     ├── redact.ts
│     └── audit.ts
├── test/
│  ├── unit/
│  ├── integration/
│  ├── e2e/
│  └── fixtures/
└── docs/
   ├── setup.md
   ├── commands.md
   └── security.md
```

**Runtime and dependency policy:** prefer Web APIs and pure JS. The plugin path runs inside OpenCode's server runtime (Bun-based in the CLI build); the daemon can run on Node 22+ or Bun. Avoid native modules in the plugin path; SQLite belongs to the daemon, while embedded mode uses `ctx.storage`. Pin `@opencode/plugin`, `@opencode/client`, and the Bot API surface, and keep the OpenCode adapter as the only compatibility boundary.

### 5.2 Runtime components

| Component | Responsibility |
|---|---|
| **Telegram transport** | Long polling (default) or webhook; raw update dedupe by `update_id`; typed Bot API wrapper for 10.3 rich methods. |
| **Update router** | Auth → callback/message classification → command or session action → enqueue. |
| **OpenCode adapter** | Same interface for `ctx` (plugin) and `@opencode/client` (daemon); hides request/location differences. |
| **Event normalizer** | Adds session/turn identity, orders per session using `durable.seq` when present, tags location. |
| **Session actor** | One serialized async queue per active session; owns turn state, view model, and idempotent actions. |
| **Renderer** | Markdown → sanitized rich HTML; legacy fallback; chunking; templates. |
| **Outbox** | Priority queue, per-chat/global token buckets, idempotency keys, 429 backoff, persistence. |
| **Store** | SQLite for daemon; `ctx.storage` JSON for embedded; message maps, bindings, audit, outbox. |
| **Admin API** | Localhost-only pairing/status/send/reload for CLI and TUI. |
| **Reconciler** | On connect/reconnect: list active sessions, fetch context, rebuild panels, mark stale turns. |

### 5.3 Event pipeline

```text
OpenCode event stream
        │
        ▼
  Normalizer ──► dedupe / order / location
        │
        ▼
  SessionActor (serialized per session)
    ├── TurnBuffer (text, reasoning, tools, usage)
    ├── ViewModel (panel, answer, activity, approval)
    └── RenderScheduler (coalesce + priority)
        │
        ▼
  TelegramOutbox (rate limit, retry, idempotency)
        │
        ▼
  Bot API (draft / rich send / edit / pin / keyboard)
```

Why actors: deltas, tool events, and status updates for one session can arrive interleaved. A per-session serialized queue removes races: every event sees a consistent turn state, and Telegram edits are ordered.

Turn state machine:

```text
idle
  └─ admitted ──► thinking ──► streaming_text
                       │              │
                       │              ├─► tool_wait ──► streaming_text
                       │              │
                       └──────────────┴─► finalizing ──► done
                                             ├─► failed
                                             └─► interrupted
```

Evict an actor after `idle + 10 min`; persist enough to rebuild it from `session.get` and `session.context`.

### 5.4 Event → UI mapping

These are the actual V2 event names and payloads (verified against `@opencode/client` 2.2.0):

| Event | UI effect |
|---|---|
| `session.created` | Add to Home; create topic if auto-topic is on |
| `session.updated` / `session.renamed` | Update panel title and topic name |
| `session.status` (`idle`/`busy`/`retry`) | Panel status; retry countdown |
| `session.execution.started` | Create turn; thinking draft; typing |
| `session.step.started` | Show agent/model; reset step timer |
| `session.step.ended` | Cost/tokens/files; update panel |
| `session.step.failed` | Error card; keep turn open for retry |
| `session.text.started` | Create answer segment; allocate draft/message |
| `session.text.delta` | Append; schedule render |
| `session.text.ended` | Finalize exact segment text |
| `session.reasoning.started/delta/ended` | `<tg-thinking>` in draft; collapsed details after final |
| `session.tool.input.started` | Record tool ID → name; “preparing…” |
| `session.tool.input.delta/ended` | Optional tool input preview |
| `session.tool.called` | Add activity row; show input summary |
| `session.tool.progress` | Update row detail (throttled) |
| `session.tool.success` | Mark row ✓ + duration; collapse output |
| `session.tool.failed` | Mark row ✗; show error behind details |
| `session.execution.succeeded` | Final footer + actions; notify |
| `session.execution.failed` | Error card with Retry/Switch/Compact |
| `session.execution.interrupted` | “Stopped by you/shutdown/superseded” |
| `session.idle` | Clear typing; panel idle; persist |
| `session.retry.scheduled` | “Retrying in Ns (attempt k)” + countdown |
| `session.compaction.*` | “Compacting context…” status |
| `session.usage.updated` | Cost/tokens in panel |
| `session.inbox.enqueued/delivered/cancelled` | Queued prompt indicator |
| `session.revert.staged/committed/cleared` | Update revert card |
| `permission.asked` | Approval card |
| `permission.replied` | Update/close approval card |
| `form.created` | Open form wizard |
| `form.replied` / `form.cancelled` | Update/close wizard |
| `vcs.branch.updated` | Panel branch |
| `mcp.status.changed` | Optional badge/alert |
| `config.updated` | Reload settings/commands |
| `worktree.updated` | Refresh workspace list |
| `plugin.updated` | Refresh plugin status |
| `server.connected` | Daemon only: trigger reconciliation |

Notes:

- The plugin event stream never receives `server.connected` (documented). The daemon client does.
- Subscriptions are **live-only**: no replay, no automatic reconnection. On reconnect, run the reconciler — do not assume missed events will arrive.
- `session.tool.called` does not carry the tool name; track it from `session.tool.input.started` (which has `name`), or fall back to the message content.
- Use `session.text.ended` (not accumulated deltas) for the final text; deltas are for liveness.

### 5.5 Rendering pipeline

```text
OpenCode Markdown
  → remark/MDAST
  → transform to rich HTML (tables, details, lists, code, math)
  → sanitize/escape all model text
  → validate limits
  → rich message (sendRichMessage / editMessageText.rich_message)
  → fallback: legacy HTML (4096) → plain text
```

Rich message limits (Telegram 10.3): **32,768 UTF-8 characters**, **500 blocks**, **16 nesting levels**, **50 media attachments**, **20 table columns**. Legacy messages: **4,096 characters**.

Rules:

- Use `InputRichMessage.html`, not `markdown`, so we control tags and Telegram-specific blocks.
- Escape model output first; only the renderer may emit `<details>`, `<tg-button-row>`, `<tg-thinking>`, `<table>`, etc. This prevents prompt-injected HTML/buttons.
- Allow links only `http:`, `https:`, `mailto:`, `tel:`; strip `javascript:`, `tg://`, and unknown schemes from model output.
- Set `skip_entity_detection: true` to avoid accidental `@mentions`, phone links, or cashtags from model text; add links explicitly.
- Tables: GFM table → `<table bordered striped compact>`; truncate cells; cap columns at 20.
- Code: `<pre><code class="language-…">`; diffs use `language-diff`; very long code goes into `<details>` or a file.
- Reasoning: `<tg-thinking>` in drafts; after final, a collapsed `<details><summary>Reasoning</summary>…</details>` only in verbose mode.
- Tool activity: one `<details>` per turn; rows are compact; input/output truncated; full output downloadable.
- Math: `$…$` / `$$…$$` → `<tg-math>` / `<tg-math-block>`; optional.
- Images: prefer uploaded Telegram media; avoid remote hotlinks that leak IPs.
- Chunking: split at block boundaries, never inside a tag; re-open code fences with the same language; add `(1/n)` only when necessary.
- Fallback: if a rich send/edit fails with a 400 indicating unsupported rich content, downgrade that message to legacy HTML and cache the downgrade per chat/client.

### 5.6 Rate limiting and coalescing

Telegram documents ~**30 messages/second** for broadcasts. Per-chat limits for bots are not contractual; observed behavior is much stricter. Budget conservatively:

| Bucket | Budget | Behavior |
|---|---|---|
| Per-chat messages | 1 per 1.2 s, burst 3 | Queue; coalesce edits |
| Per-chat edits | 1 per 1.2 s | Only if content changed materially |
| Group messages | ~20/min soft cap | Prefer edits; batch |
| Global sends | 25/s | Hard budget under the 30/s broadcast limit |
| Drafts | 1 per 1.2 s | Always keep the latest; drop older |
| Callback answers | immediate | `answerCallbackQuery` within 1 s |

Priority queue:

| Priority | Examples | On overload |
|---|---|---|
| P0 | Permission cards, errors, final answers | Never drop |
| P1 | Control panel transitions, form prompts | Coalesce; delay |
| P2 | Activity updates, retry countdowns | Coalesce; skip intermediate |
| P3 | Reasoning previews, typing indicators | Drop if busy |

On `429`, read `retry_after`, pause that chat (and global if needed), and retry with jitter. Persist the outbox so a restart does not lose final answers or approvals.

### 5.7 Persistence

Daemon: SQLite (WAL). Embedded: `ctx.storage` JSON for small state, with the same repository interface.

```sql
CREATE TABLE chats (
  chat_id      INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,          -- private_topics | supergroup | compact
  workspace_id TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE sessions (
  session_id   TEXT PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  thread_id    INTEGER,
  project_dir  TEXT,
  title        TEXT,
  status       TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE TABLE turns (
  turn_id              TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  assistant_message_id TEXT,
  draft_id             INTEGER,
  message_id           INTEGER,
  phase                TEXT NOT NULL,  -- thinking|streaming|tool|final|failed|interrupted
  text_hash            TEXT,
  started_at           INTEGER,
  ended_at             INTEGER
);

CREATE TABLE prompts (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  chat_id            INTEGER,
  telegram_message_id INTEGER,
  user_id            INTEGER,
  state              TEXT NOT NULL,   -- queued|delivered|cancelled
  created_at         INTEGER
);

CREATE TABLE permissions (
  request_id  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  chat_id     INTEGER,
  message_id  INTEGER,
  expires_at  INTEGER,
  state       TEXT NOT NULL           -- pending|approved|rejected|expired
);

CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  chat_id      INTEGER,
  thread_id    INTEGER,
  priority     INTEGER,
  payload      TEXT,
  attempts     INTEGER DEFAULT 0,
  next_at      INTEGER,
  created_at   INTEGER
);

CREATE TABLE pairings (
  code_hash   TEXT PRIMARY KEY,
  user_id     INTEGER,
  chat_id     INTEGER,
  role        TEXT,
  expires_at  INTEGER,
  used_at     INTEGER
);

CREATE TABLE audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  user_id    INTEGER,
  chat_id    INTEGER,
  session_id TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  result     TEXT
);
```

Retention: prune outbox after 7 days, prompts after 30 days, audit after 180 days (configurable). Keep message maps for active/recent sessions; prune archived sessions after 90 days. Back up nightly; SQLite file permissions `0600`.

### 5.8 OpenCode integration map

| User action | OpenCode API |
|---|---|
| Send prompt | `POST /api/session/{id}/prompt` with `text`, `files`, `metadata`, `delivery` |
| Stop | `POST /api/session/{id}/interrupt` |
| New session | `POST /api/session` |
| List sessions | `GET /api/session` (cursor) / `GET /api/session/active` |
| Switch model | `POST /api/session/{id}/model` |
| Switch agent | `POST /api/session/{id}/agent` |
| Rename/archive | `PATCH /api/session/{id}` |
| Fork | `POST /api/session/{id}/fork` |
| Compact | `POST /api/session/{id}/compact` |
| Context/messages | `GET /api/session/{id}/context`, `GET /api/session/{id}/message` |
| Export session | `GET /api/experimental/session/{id}/export` |
| Revert | `POST /api/session/{id}/revert/stage`, `/commit`, `DELETE /revert` |
| Diff | `GET /api/session/{id}/diff`, `GET /api/vcs/diff` |
| Files | `GET /api/fs/list`, `GET /api/fs/read/*`, `POST /api/experimental/fs/write` |
| Permissions | `GET/POST /api/session/{id}/permission…/reply` |
| Forms | `GET /api/session/{id}/form`, `POST …/form/{formID}/reply` |
| Commands | `GET /api/command`, `POST /api/session/{id}/command` |
| Skills | `GET /api/skill`, `POST /api/experimental/session/{id}/skill` |
| MCP | `GET /api/mcp`, `POST /api/experimental/mcp/{server}/connect` |
| Usage | `GET /api/experimental/usage/limits` |
| Models/agents | `GET /api/model`, `GET /api/agent` |
| Events | `GET /api/event` |
| Voice (optional) | `GET /api/experimental/voice/models`, `POST /api/experimental/voice/session` |

### 5.9 The plugin part

The plugin is small on purpose. It does three jobs: install the remote-safety policy, expose pairing/status over RPC, and optionally host the bot. **Daemon-only installs still work, but they lose the server-side policy**; load the plugin alongside the daemon if you want Telegram-originated sessions to be stricter than local ones.

RPC registration and the bot token are server-scoped: enable `host: "embedded"` in exactly one location, or use the daemon. If a daemon is already healthy, the embedded host should detect it and stay passive rather than starting a second poller.

```ts
import { Plugin } from "@opencode/plugin"
import { TelegramRpc } from "./rpc.js"
import { loadConfig } from "./core/config.js"
import { installRemoteSafety } from "./security/policy.js"
import { startEmbedded } from "./host/embedded.js"

export default Plugin.define({
  id: "opencodegram",
  async setup(ctx) {
    const config = await loadConfig(ctx.options)
    const policy = await installRemoteSafety(ctx, config)
    const rpc = await ctx.rpc.register(TelegramRpc, {
      status: async () => botStatus(),        // reads daemon admin API or local state
      pair: async () => createPairingCode(), // short-lived, single-use code
    })

    const embedded = config.host === "embedded"
      ? await startEmbedded(ctx, config)
      : undefined

    return async () => {
      await embedded?.stop()
      await rpc.dispose()
      await policy.dispose()
    }
  },
})
```

Remote-safety policy:

```ts
export async function installRemoteSafety(ctx: Context, config: Config) {
  const remote = new Set<string>()
  const escalate = config.security?.escalate ?? ["shell", "edit", "external_directory"]

  // Tag sessions prompted from Telegram. The daemon sets this metadata.
  const promptHook = await ctx.session.hook("prompt", (event) => {
    if (event.metadata?.telegram) remote.add(event.sessionID)
  })

  const evaluateHook = await ctx.permission.hook("evaluate", (event) => {
    if (!remote.has(event.sessionID)) return
    if (event.effect !== "allow") return
    if (!escalate.includes(event.action)) return
    event.effect = "ask"
    event.message = "Remote session: approval required for this action."
  })

  return {
    dispose: async () => {
      await promptHook.dispose()
      await evaluateHook.dispose()
    },
  }
}
```

Persist the remote-session set (for example in `ctx.storage`, keyed by session ID) so the policy survives restarts; the in-memory `Set` above is only for brevity.

TUI companion:

- `/telegram` opens a dialog: status, bot username, mode, active sessions, pending approvals.
- “Pair a device” shows a code and a `https://t.me/<bot>?start=<code>` link (plus a QR code in the terminal if available).
- Footer badge: `TG ✓` connected, `TG ⚠` degraded, `TG ✕` disconnected.
- Clicking a session link calls the admin API or RPC to focus/open the session.
- Uses `@opencode/plugin/tui` (commands, dialogs, slots) and the RPC contract when embedded.

### 5.10 The daemon part

```bash
# One-time setup
opencodegram init          # writes config, checks getMe, prints BotFather checklist
opencodegram pair          # prints a pairing code + deep link
opencodegram serve         # long-poll or webhook
opencodegram doctor        # config, token, OpenCode, Telegram, DB checks
```

Daemon responsibilities:

- Own the single Telegram long-poll/webhook consumer.
- Connect to one or more OpenCode servers/locations via `@opencode/client`.
- For a local install, prefer `Service.ensure()` + `Service.headers()` from `@opencode/client/service` over hand-managed URLs/tokens; use an explicit `baseUrl` + bearer token only for remote servers.
- Reconcile on `server.connected`.
- Serve the localhost admin API for CLI/TUI.
- Expose `/healthz` and `/metrics`.
- Run migrations, backups, retention.

All session operations are scoped to a location (the project directory). Pass it explicitly through the client's location/request options; never rely on the daemon's current working directory for project selection.

### 5.11 Configuration

`opencode.jsonc` (plugin entry, optional if you only run the daemon):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencodegram",
      "options": {
        "config": "~/.config/opencode/telegram.jsonc",
        "host": "daemon"
      }
    }
  ]
}
```

`~/.config/opencode/telegram.jsonc`:

> `host` decides where the bot runs (`daemon` or `embedded`). `chatMode` decides how Telegram is organized (`private-topics`, `supergroup`, or `compact`). They are independent.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/your-org/opencodegram/main/schema.json",
  "chatMode": "private-topics",          // private-topics | supergroup | compact
  "host": "daemon",                      // daemon | embedded
  "tokenEnv": "TELEGRAM_BOT_TOKEN",
  "opencode": {
    "baseUrl": "http://127.0.0.1:4096",
    "tokenEnv": "OPENCODE_SERVER_TOKEN"
  },
  "access": {
    "allowedUserIds": [123456789],
    "adminUserIds": [123456789]
  },
  "streaming": {
    "draftIntervalMs": 1200,
    "groupEditIntervalMs": 1500,
    "showReasoning": "collapsed"         // off | collapsed | live
  },
  "permissions": {
    "timeoutMs": 600000,
    "allowAlways": "admin"               // admin | approver | disabled
  },
  "security": {
    "escalate": ["shell", "edit", "external_directory"]
  },
  "features": {
    "voice": true,
    "files": true,
    "shell": false,
    "pty": false,
    "miniApp": false
  },
  "storage": {
    "path": "~/.local/share/opencode/telegram.sqlite",
    "retentionDays": 90
  },
  "adminApi": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

Environment:

```bash
TELEGRAM_BOT_TOKEN=...
OPENCODE_SERVER_URL=http://127.0.0.1:4096
OPENCODE_SERVER_TOKEN=...
```

Precedence: environment variables override the config file; plugin `options` override the shared file for `host`. Use separate bots/tokens for dev, staging, and production.

Never put the bot token in `opencode.jsonc`, logs, or Telegram messages. Use env/secret manager; rotate via @BotFather if leaked.

### 5.12 Security model

Threat model:

| Threat | Control |
|---|---|
| Stolen bot token | Secret manager; rotation; webhook secret; IP allowlist if webhook; no token in config/logs |
| Unauthorized Telegram user | Pairing + allowlist + roles; ignore unknown chats/users; audit failures |
| Forged/replayed callback | Opaque, short, stored callback IDs; validate user/chat/session/action; re-check permission state; idempotency keys |
| Stale approval | Expiry + auto-reject; edit card to “Expired”; re-fetch request before reply |
| Prompt injection via forwarded content | Treat all content as untrusted; bot never executes instructions from message text; OpenCode permissions remain authoritative |
| Secret exfiltration | Redact token/key patterns in logs and errors; restrict file reads; `.env` asks by default; no raw environment dump |
| Remote shell abuse | Shell/PTY off by default; admin-only; per-command confirmation; remote-safety escalation; audit |
| Path traversal / malicious upload | Quarantine; canonicalize paths; no symlink escapes; size/type limits; no execution |
| Telegram account takeover | Roles + approvals; destructive actions confirm; approval audit; optional 2FA/TOTP for “Always allow” |
| Data leakage via rich media | Prefer uploaded media over remote hotlinks; avoid embedding private URLs; state that Telegram cloud chats are not E2E |
| Denial of service / cost | Per-user rate limits; prompt size limits; daily cost alerts; abort/compact actions |

Additional rules:

- Bind the admin API to `127.0.0.1` only; use a random token file with `0600`.
- Validate webhook `X-Telegram-Bot-Api-Secret-Token`.
- Encrypt SQLite at rest if the host is shared (SQLCipher or filesystem encryption).
- Add a “panic” command for admins: stop polling, kill running sessions, clear tokens? At minimum `opencodegram disable` and `/revoke`.
- Audit every state-changing action; never log full prompts by default (hash + length, or opt-in).

### 5.13 Failure handling

| Failure | Behavior |
|---|---|
| Telegram 429 | Honor `retry_after`; pause chat/global; persist outbox; retry with jitter |
| Telegram 400 (rich unsupported) | Downgrade that message to legacy HTML/plain; cache downgrade |
| Telegram network down | Exponential backoff; health degraded; queue final/approval messages |
| OpenCode server down | “Control plane offline” card; retry; on reconnect reconcile active sessions |
| Bot restart mid-turn | Load state; send “Recovered after restart; output may be incomplete” and reconcile from `session.context` |
| Missed events | Reconciler uses `session.active`, `session.get`, `session.context`; never assume replay |
| Duplicate update | Dedupe by `update_id`; idempotent callbacks |
| Out-of-order deltas | Per-session actor + `durable.seq`; final text from `session.text.ended` |
| Permission timeout | Auto-reject with message; edit card; audit |
| Form abandoned | Expire wizard; cancel form with message; allow restart from card |
| Chat/topic deleted | Mark binding stale; recreate on next action; never crash |
| Huge output | Truncate card; attach full `.md`/`.diff`/log |
| Model/context error | Error card with Retry, Switch model, Compact, Show logs |
| Rate-limit storm | Shed P2/P3 updates; preserve P0/P1 |

---

## 6. Delivery plan

Assumption: one senior TypeScript developer, part-time design/QA, a dedicated test bot and test workspace. Estimates are dev-days, not calendar promises.

### Phase 0 — Spike (3–5 days)

**Goal:** prove the three riskiest integrations before building product.

- Telegram 10.3 rich message + draft round-trip in a test bot.
- OpenCode plugin event stream: text deltas, tool events, permission request/reply.
- Stop flow via `stopped_message_generation` → `session.interrupt`.
- `getMe.has_topics_enabled` and `createForumTopic` in a private chat (or document fallback).

**Deliverable:** a CLI spike that streams a real OpenCode turn into Telegram, approves one permission, and stops a generation.

**Acceptance:** demo on a phone; no polling conflicts; draft finalizes; stop interrupts.

### Phase 1 — MVP (8–10 days)

**Scope:**

- Package scaffold, config schema, CI, lint/typecheck/test.
- Daemon host + `@opencode/client` adapter + event normalizer + reconciler.
- Pairing (CLI/TUI), allowlist, owner role.
- One workspace, one active session per chat (compact mode first).
- Prompt text; live streaming via drafts (private) / edits (group).
- Control panel; Stop; model/agent pickers; final footer.
- Permission cards with once/always/reject/expiry.
- Error cards; `/status`, `/new`, `/sessions`, `/stop`, `/model`, `/agent`, `/help`.
- SQLite schema + migrations; outbox; rate limiter; structured logs.
- Basic tests: renderer, rate limiter, actor, callback auth.

**Acceptance:**

- Pair → prompt → stream → final in under 3 s to first visible output.
- Approve/deny from Telegram; TUI sees the same decision.
- Stop works from both the draft button and `/stop`.
- Restart the daemon mid-turn; the next action recovers.
- 20-message burst does not trip 429 or flood the chat.

### Phase 2 — The great UI (10–15 days)

**Scope:**

- Private topics: auto-create/rename/close/reopen topics; Home control room.
- Pinned panel; rich tables/details; activity aggregation; reasoning collapse.
- Rich message templates for sessions, models, diffs, files, usage.
- Diffs: working/branch/last-turn; preview; download; revert.
- File browser/upload; photo/document attachments; quarantine.
- Forms wizard (boolean/options/free-text first; multiselect/conditions next).
- Notifications/mute; pending approvals view; daily digest.
- `/diff`, `/files`, `/send`, `/compact`, `/rename`, `/fork`, `/archive`, `/usage`, `/settings`.
- TUI companion: `/telegram`, pairing code, badge, approval count.
- Fallback paths: rich → legacy; topics → compact; drafts → edits.
- Golden tests for all templates; E2E scenarios.

**Acceptance:**

- A full day of real work can be done from Telegram without touching the TUI (except deep code review).
- No duplicate/spam messages in a 10-turn tool-heavy session.
- Rich cards render on desktop, iOS, Android, and Web (or fall back cleanly).
- Permission delivery <1 s; expiry works.

### Phase 3 — Team and scale (8–12 days)

**Scope:**

- Supergroup mode; roles (owner/admin/approver/operator/viewer); per-workspace ACL.
- Ephemeral approval cards in groups (only the approver sees the sensitive card).
- Multi-project/multi-location; workspace switcher; project cards.
- Session search/filter; pagination; “my sessions” vs “all.”
- Queue/steer behavior when a session is busy; queued prompt indicators.
- Audit UI/export; cost budgets and alerts.
- Voice transcription (local `whisper.cpp` default; optional API).
- MCP status panel; connect/disconnect where safe.
- Admin API + `doctor`; metrics; backup/restore; Docker Compose.
- Load/soak tests; security review.

**Acceptance:**

- 3 users, 2 projects, 20 concurrent sessions; no cross-user leakage.
- Unauthorized callbacks rejected; audit shows every approval.
- 50-session soak with 20 events/s; P0 latency within target.

### Phase 4 — Hardening and release (5–8 days)

**Scope:**

- Docs: setup, BotFather checklist, commands, security, troubleshooting.
- Migration guide from embedded to daemon.
- Version compatibility matrix and CI against OpenCode minor releases.
- `npm publish`, Docker image, systemd unit, Homebrew (optional).
- Release notes, demo video/GIF, sample configs.
- Bug bash on real devices; accessibility review; copy polish.

**Acceptance:** a new user can go from zero to paired in <10 minutes using the docs; upgrade preserves state.

### Timeline

| Week | Milestone |
|---|---|
| 1 | Phase 0 spike demo |
| 2–3 | MVP: pair, prompt, stream, stop, permissions |
| 4–6 | Great UI: topics, panels, diffs, files, forms, TUI |
| 7–8 | Team/scale: roles, multi-project, voice, audit, Docker |
| 9–10 | Hardening, docs, release |

With two developers, parallelize daemon/core (dev A) and Telegram UX/renderer (dev B); target 5–6 weeks.

---

## 7. Testing and QA

### 7.1 Test matrix

| Layer | What | Tools |
|---|---|---|
| Unit | Renderer (Markdown → rich HTML), chunker, sanitizer, rate limiter, callback parser, form validator, policy | Vitest/Bun test, golden fixtures |
| Contract | Event payloads against `@opencode/client` types; request/response shapes | TypeScript, OpenAPI snapshots |
| Integration | Actor + outbox + fake Telegram + fake OpenCode | MSW/fetch mock, fake timers |
| E2E | Real test bot + real `opencode serve` + temp workspace | Nightly CI, dedicated test group |
| Load | 50 sessions, 20 events/s, 429 storms | k6/custom harness |
| Security | Auth bypass, replay, HTML injection, path traversal, oversized files, token leak scan | Adversarial tests |
| Device | Desktop, iOS, Android, Web; rich + fallback | Manual checklist |

### 7.2 E2E scenarios

1. Pair → new session → prompt → stream → final.
2. Approve once; approve always (verify saved pattern); reject; reject with reason.
3. Permission timeout → auto-reject → session continues.
4. Tool failure → error card → retry → success.
5. Long output (>32k / >500 blocks) → split + attachment.
6. Topic create/rename/close/reopen; archive session.
7. Upload a document/photo → attach to prompt; download a diff.
8. Form with boolean, options, free text, multiselect, conditional field.
9. Daemon restart mid-turn → recovery card → continue.
10. Kill OpenCode mid-turn → offline card → reconnect → reconcile.
11. 429 storm → backoff → final message still delivered.
12. Unauthorized user/callback/replay → rejected + audited.
13. Prompt with `<script>`, fake `<tg-button>`, `javascript:` link → escaped/stripped.
14. Voice message → transcript → send/edit/cancel.
15. 50-session soak → no flood, bounded queue, memory stable.

### 7.3 Definition of done

- Tests pass in CI; no `any` in core contracts; lint/typecheck clean.
- Every user-facing string is in a catalog; no raw stack traces.
- Every destructive action has confirmation + audit.
- Every Telegram call has a timeout, retry policy, and 429 path.
- Every rich template has a legacy golden test.
- Docs updated; demo recorded.

---

## 8. Operations

### 8.1 Observability

- **Logs:** pino JSON; fields `update_id`, `chat_id_hash`, `session_id`, `turn_id`, `action`, `latency_ms`; redact tokens, prompts, file contents.
- **Metrics:** updates/s, sends/s, edits/s, 429s, queue depth, render latency, permission latency, active sessions, errors by class, draft finalization rate.
- **Health:** `/healthz` checks Telegram `getMe`, OpenCode `/api/info`, SQLite writable, outbox age.
- **Audit:** separate append-only table/file; export CSV/JSON.
- **Alerts:** bot offline >2 min; OpenCode offline >2 min; outbox P0 age >30 s; 429 rate >5%; permission backlog >10.

### 8.2 Deployment

**Local:**

```bash
opencode serve --port 4096
TELEGRAM_BOT_TOKEN=... opencodegram serve
```

**Docker Compose:**

```yaml
services:
  opencode:
    image: ghcr.io/your-org/opencode:2.2
    command: ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
    volumes:
      - ./workspace:/workspace
      - opencode-data:/root/.local/share/opencode
    environment:
      OPENCODE_SERVER_TOKEN: ${OPENCODE_SERVER_TOKEN}

  telegram:
    image: ghcr.io/your-org/opencodegram:latest
    depends_on: [opencode]
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      OPENCODE_SERVER_URL: http://opencode:4096
      OPENCODE_SERVER_TOKEN: ${OPENCODE_SERVER_TOKEN}
    volumes:
      - telegram-data:/data
    ports:
      - "127.0.0.1:8787:8787"   # admin API only on localhost
    healthcheck:
      test: ["CMD", "opencodegram", "health"]
      interval: 30s
```

**Systemd:** one unit for the daemon, `Restart=on-failure`, `EnvironmentFile=`, `StateDirectory=opencodegram`.

**Webhook (optional):** only if long polling is blocked; Caddy/nginx TLS; secret token; validate `X-Telegram-Bot-Api-Secret-Token`; still keep the admin API local.

### 8.3 Backup and retention

- Nightly SQLite backup (`VACUUM INTO`), keep 7 daily/4 weekly.
- Retention defaults: outbox 7d, prompts 30d, audit 180d, archived sessions 90d.
- Provide `opencodegram export` (JSON) and `import` for migration.
- Unpair/delete removes chat bindings and optionally all message maps.

---

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Telegram rich messages/drafts are new (10.3, Aug 2026); libraries lag | High | Medium | Thin typed API wrapper; raw updates; feature flags; legacy fallback; pin Bot API behavior in tests |
| Private topics require BotFather enablement / client support | Medium | High | Detect `has_topics_enabled`; onboarding checklist; fall back to compact or supergroup |
| Per-chat rate limits are undocumented | High | Medium | Conservative token buckets; coalescing; priority shedding; 429 handling; soak tests |
| OpenCode V2 plugin/API changes | Medium | High | Pin versions; adapter boundary; CI against minor releases; prefer public HTTP API over internals |
| Multi-location/token conflicts in embedded mode | Medium | High | Daemon is primary; embedded is single-location; detect daemon and disable embedded polling; clear docs |
| Security incident via bot token/account | Low | Critical | Secret management; pairing/roles; expiry; audit; remote-safety policy; shell off by default |
| Permission fatigue | Medium | Medium | Risk summaries; “Always” with pattern preview; batch related approvals; quiet mode |
| Rich output too large / expensive | Medium | Medium | 32k/500-block validation; attach files; truncate details; cost alerts |
| Message state lost on restart | Medium | Medium | Persist message maps; reconcile; “recovered” card; never assume Telegram history access |
| Form wizard complexity | Medium | Medium | MVP subset; one field at a time; cancel/restart; typed field handlers |
| Voice transcription quality/cost | Medium | Low | Local whisper default; show transcript for edit; opt-in |
| Telegram cloud privacy | Certain | Medium | State that chats are not E2E; avoid secrets; redaction; retention controls |

---

## 10. Alternatives considered

| Alternative | Why not (for v1) |
|---|---|
| **TUI over SSH / tmux** | Great for terminal users, not mobile; no approvals on the go; poor notifications. |
| **Web dashboard** | Powerful, but another UI to build and secure; Telegram is already on the phone. Add a Mini App later if needed. |
| **Discord/Slack/Matrix** | Possible later via the same core; Telegram has the best bot + topics + mobile notification fit for this use case. |
| **Pure webhook bot** | Long polling is simpler behind NAT and for local OpenCode; webhook optional for hosted deployments. |
| **Pure embedded plugin** | Demo-friendly but operationally fragile; chosen as a mode, not the foundation. |
| **Generic “chat with coding agent” bot** | Loses sessions, permissions, diffs, and file context; not full control. |

---

## 11. Confirmed decisions

Confirmed on 2026-10-28. These are now the v1 baseline; changing one requires a scope review.

| Decision | Confirmed choice | Consequence |
|---|---|---|
| **Primary mode** | Private chat + topics | One forum topic per session. Compact mode remains the fallback when Telegram does not expose topics. |
| **Host** | Daemon for daily use, embedded for zero-config | Both adapters ship from the shared core. The daemon is the production target; embedded mode is the onboarding path. |
| **Audience** | Solo first, team in Phase 3 | v1 has one owner and a simple approver model. Roles, ACLs, and multi-approver flows stay in Phase 3. |
| **Shell/PTY** | Off by default; admin-only opt-in | No shell tool is exposed to Telegram until explicitly enabled, confirmed, and audited. |
| **Voice** | Local `whisper.cpp` default, API optional | Voice notes become editable transcripts; audio never leaves the host by default. |
| **Mini App** | Defer to Phase 5 | Rich messages cover sessions, diffs, and approvals. Revisit after beta usage data. |
| **Language** | English first, i18n-ready | UI strings live in catalogs from day one; no runtime translation work in v1. |
| **Bot API** | Target 10.3, fallback to legacy HTML | Rich messages and drafts are the differentiator; the fallback keeps older clients usable. |

**Remaining inputs before the Phase 0 demo:** a test bot token supplied via `.env` (never in chat), the admin Telegram user ID, and one real pilot project with a permission rule set to `ask`.

---

## 12. Immediate next steps

1. **Create the bot** in @BotFather:
   - `/newbot`, choose name/username.
   - Enable **Topics in Private Chats** if shown (Bot Settings → Topics).
   - Set privacy mode (disable only if you want plain group messages; otherwise `/ask` is fine).
   - Set description, about, and profile photo.
2. **Get your Telegram user ID** (e.g., via `@userinfobot`) and decide admin IDs.
3. **Prepare a test workspace** with a small OpenCode session and a permission rule that asks (e.g., `shell: "*" → ask`).
4. **Scaffold Phase 0:**
   - package + config schema + CI;
   - daemon skeleton with `getMe`, `getUpdates`, `sendRichMessage`, `sendRichMessageDraft`;
   - OpenCode event subscription and a single-session actor;
   - permission card + reply;
   - stop flow.
5. **Demo script:** pair → prompt → stream → approve → stop → final → restart → recover.
6. **Then** lock Phase 1 scope and build the real store/outbox/rate limiter.

**What I need from you to run the demo:** provide a test bot token via `.env` (never in chat), your admin Telegram user ID, and the name of one real pilot project with a permission rule set to `ask`.

---

## Appendix A — Command reference

| Command | Args | Notes |
|---|---|---|
| `/start` | — | Welcome + pairing |
| `/help` | `[topic]` | Contextual help |
| `/pair` | `[code]` | Pair this chat |
| `/home` | — | Control room |
| `/sessions` | `[page]` | Paginated |
| `/new` | `[title]` | Create + topic |
| `/switch` | `[session]` | Picker |
| `/status` | — | Panel |
| `/stop` | — | Interrupt |
| `/model` | `[provider/model]` | Picker |
| `/agent` | `[name]` | Picker |
| `/variant` | `[name]` | Model variant |
| `/compact` | — | Compact context |
| `/rename` | `<title>` | Rename session/topic |
| `/fork` | `[message]` | Fork |
| `/archive` | — | Archive + close topic |
| `/delete` | — | Confirm |
| `/export` | `[md\|json]` | Transcript/file |
| `/diff` | `[working\|branch\|turn]` | Diff card |
| `/files` | `[path]` | Browser |
| `/send` | `<path>` | Send file |
| `/revert` | `[stage\|commit\|clear]` | Revert |
| `/commands` | — | OpenCode commands |
| `/skills` | — | Skills |
| `/mcp` | — | MCP status |
| `/usage` | `[today\|session]` | Cost/tokens |
| `/quiet` | — | Mute progress |
| `/verbose` | — | Show reasoning/activity |
| `/settings` | — | Inline settings |
| `/whoami` | — | Role/binding |

## Appendix B — Rich message recipes

Control panel (rich HTML):

```html
<h2>📌 Fix auth refresh</h2>
<p>🟢 <b>running</b> · build · claude-sonnet-5-5</p>
<table bordered striped compact>
  <tr><td>Step</td><td>3</td></tr>
  <tr><td>Tokens</td><td>12.4k in / 1.8k out</td></tr>
  <tr><td>Cost</td><td>$0.08</td></tr>
  <tr><td>Elapsed</td><td>00:42</td></tr>
  <tr><td>Branch</td><td>main</td></tr>
</table>
<p>4 files changed · 1 approval pending</p>
```

Approval card:

```html
<h2>🔐 Approval needed · shell</h2>
<p>Risk: <mark>medium</mark> · requested by <b>build</b> · expires in 9:41</p>
<pre><code class="language-bash">npm test -- --runInBand</code></pre>
<p>in <code>/path/to/opencodegram</code></p>
<details>
  <summary>Why this was requested</summary>
  Run the regression suite after editing refresh.ts.
</details>
```

Activity card:

```html
<details>
  <summary>▸ Activity · 4 tools · 12s</summary>
  <ul>
    <li>✓ <code>read</code> src/auth/refresh.ts · 0.2s</li>
    <li>✓ <code>grep</code> "refreshToken" · 0.1s</li>
    <li>✓ <code>edit</code> src/auth/refresh.ts · 1.8s</li>
    <li>✓ <code>shell</code> npm test -- --runInBand · 9.4s</li>
  </ul>
</details>
```

Session table:

```html
<table bordered striped compact>
  <tr><th>Session</th><th>Status</th><th>Model</th><th>Cost</th></tr>
  <tr><td>Fix auth refresh</td><td>🟢 running</td><td>sonnet-5-5</td><td>$0.08</td></tr>
  <tr><td>Add Telegram bot</td><td>🟡 retry</td><td>gpt-5</td><td>$0.21</td></tr>
  <tr><td>Refactor renderer</td><td>⚪ idle</td><td>sonnet-5-5</td><td>$0.04</td></tr>
</table>
```

## Appendix C — Sources and assumptions

- OpenCode V2 docs: plugins, server plugins, TUI plugins, RPC, client, API, permissions.
- `@opencode/plugin` and `@opencode/client` 2.2.0 type definitions (event names/payloads verified).
- Telegram Bot API 10.3 (2026-08-24): rich messages, rich drafts, ephemeral messages, topics in private chats.
- Telegram Bot API limits: 4,096 chars legacy; 32,768 UTF-8 chars rich; 500 blocks; 20 table columns; `callback_data` 1–64 bytes; ~30 messages/s broadcast.
- Assumption: OpenCode 2.2.x and Bot API 10.3 remain available; pin versions and test upgrades.
- Assumption: the user can enable private-chat topics in @BotFather. If not, the fallback is a supergroup with topics or compact mode.
