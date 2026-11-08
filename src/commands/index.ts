import type { BotDeps, SendFn } from "../context.js";

// Re-export all handler groups.
export * from "./sessions.js";
export * from "./files.js";
export * from "./vcs.js";
export * from "./forms.js";
export * from "./mcp.js";
export * from "./misc.js";
export * from "./shared.js";

import * as sessionsCmds from "./sessions.js";
import * as filesCmds from "./files.js";
import * as vcsCmds from "./vcs.js";
import * as formsCmds from "./forms.js";
import * as mcpCmds from "./mcp.js";
import * as miscCmds from "./misc.js";

const {
  cmd_status, cmd_new, cmd_stop, cmd_fork, cmd_rename, cmd_archive, cmd_unarchive,
  cmd_delete, cmd_compact, cmd_context, cmd_usage, cmd_sync, cmd_running_sessions,
  cmd_use, cmd_diff,
} = sessionsCmds;
const { cmd_file, cmd_ls, cmd_find, cmd_zip, cmd_read, cmd_tree } = filesCmds;
const { cmd_vcs, cmd_branches, cmd_stage, cmd_unstage, cmd_commit, cmd_worktree } = vcsCmds;
const { cmd_forms, cmd_formreply } = formsCmds;
const { cmd_mcp } = mcpCmds;
const {
  cmd_start, cmd_commands, cmd_settings, cmd_models, cmd_agents, cmd_skills,
  cmd_retry, cmd_buttons,
} = miscCmds;

export const KNOWN_COMMANDS = new Set([
  "start", "help", "status", "session", "sessions", "running", "new", "stop", "abort",
  "commands", "settings", "file", "ls", "find", "read", "zip", "tree", "model", "models",
  "agent", "agents", "skill", "skills", "fork", "rename", "archive", "unarchive",
  "delete", "deletesessions", "diff", "context", "compact", "buttons", "retry",
  "vcs", "mcp", "branches", "branch", "stage", "unstage", "commit", "worktrees",
  "worktree", "usage", "forms", "formreply", "sync", "use",
]);

export const COMMANDS = new Map<string, (deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn) => Promise<boolean | void>>();

COMMANDS.set("start", cmd_start);
COMMANDS.set("help", cmd_start);
COMMANDS.set("status", cmd_status);
COMMANDS.set("session", cmd_status);
COMMANDS.set("new", cmd_new);
COMMANDS.set("stop", cmd_stop);
COMMANDS.set("abort", cmd_stop);
COMMANDS.set("commands", cmd_commands);
COMMANDS.set("settings", cmd_settings);
COMMANDS.set("file", cmd_file);
COMMANDS.set("ls", cmd_ls);
COMMANDS.set("find", cmd_find);
COMMANDS.set("zip", cmd_zip);
COMMANDS.set("read", cmd_read);
COMMANDS.set("tree", cmd_tree);
COMMANDS.set("model", cmd_models);
COMMANDS.set("models", cmd_models);
COMMANDS.set("agent", cmd_agents);
COMMANDS.set("agents", cmd_agents);
COMMANDS.set("skill", cmd_skills);
COMMANDS.set("skills", cmd_skills);
COMMANDS.set("usage", cmd_usage);
COMMANDS.set("vcs", cmd_vcs);
COMMANDS.set("mcp", cmd_mcp);
COMMANDS.set("branches", cmd_branches);
COMMANDS.set("branch", cmd_branches);
COMMANDS.set("stage", cmd_stage);
COMMANDS.set("unstage", cmd_unstage);
COMMANDS.set("commit", cmd_commit);
COMMANDS.set("worktrees", cmd_worktree);
COMMANDS.set("worktree", cmd_worktree);
COMMANDS.set("forms", cmd_forms);
COMMANDS.set("formreply", cmd_formreply);
COMMANDS.set("fork", cmd_fork);
COMMANDS.set("rename", cmd_rename);
COMMANDS.set("archive", cmd_archive);
COMMANDS.set("unarchive", cmd_unarchive);
COMMANDS.set("delete", cmd_delete);
COMMANDS.set("deletesessions", cmd_delete);
COMMANDS.set("diff", cmd_diff);
COMMANDS.set("sync", cmd_sync);
COMMANDS.set("context", cmd_context);
COMMANDS.set("compact", cmd_compact);
COMMANDS.set("buttons", cmd_buttons);
COMMANDS.set("retry", cmd_retry);
COMMANDS.set("running", cmd_running_sessions);
COMMANDS.set("sessions", cmd_running_sessions);
COMMANDS.set("use", cmd_use);

export async function handleCommand(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn): Promise<boolean> {
  const name = text.startsWith("/") ? (text.slice(1).split(/\s/, 1)[0] ?? "") : "";
  const handler = COMMANDS.get(name);
  if (!handler) return false;
  const result = await handler(deps, chatId, threadId, text, send);
  return result !== false;
}