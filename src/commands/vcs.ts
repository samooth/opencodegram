import { resolve } from "node:path";
import type { BotDeps, SendFn } from "../context.js";
import { createZipArchive, fileErrorMessage, formatBytes, prepareDocument, treeDirectory } from "../files/index.js";
import * as mcp from "../mcp.js";
import { isSettingsKey, renderSettings, settingsKeyboard } from "../settings.js";
import * as vcs from "../vcs.js";
import { clampText, colorDiff, esc, threadOpts, truncate } from "../util.js";
import { cancelAutoRetry, notePromptSent } from "../autoretry.js";
import { ctx } from "./shared.js";

export async function cmd_vcs(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/vcs" || text.startsWith("/vcs ")) {
    const args = text.slice(4).trim().split(/\s+/).filter(Boolean);
    const subcommand = args[0]?.toLowerCase();
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();

    if (!subcommand || subcommand === "status") {
      try {
        const status = await vcs.vcsStatus(directory);
        const lines = status.files.slice(0, 20).map((file) => `• <code>${esc(file)}</code>`);
        const fileList = status.clean ? "Working tree clean." : lines.join("\n");
        await send(`<b>VCS</b>\nBranch: <code>${esc(status.branch)}</code>\nChanged: ${status.changed}\n\n${fileList}\n\nUse /branches, /vcs diff, /stage, /unstage, /commit.`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "diff") {
      const cached = args.includes("--cached");
      const path = args.filter((arg) => arg !== "diff" && arg !== "--cached").join(" ") || undefined;
      try {
        const diff = await vcs.vcsDiff(directory, cached, path);
        if (!diff) {
          await send(cached ? "No staged changes." : "No changes.");
          return true;
        }
        await send(`<b>${cached ? "Staged diff" : "Working tree diff"}${path ? " · " + esc(path) : ""}</b>\n<pre><code class="language-diff">${colorDiff(diff.slice(0, 3500))}</code></pre>`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "log") {
      try {
        const log = await vcs.vcsLog(directory);
        await send(`<b>Recent commits</b>\n<pre>${esc(log || "(none)")}</pre>`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    await send("usage: /vcs [status|diff [--cached] [path]|log]");
    return true;
  }
  return false;
}

export async function cmd_branches(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/branches" || text === "/branch" || text.startsWith("/branch ")) {
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    const parts = text.split(/\s+/).filter(Boolean);
    const subcommand = parts[1]?.toLowerCase();
    if (!subcommand || subcommand === "list" || subcommand === "ls") {
      try {
        const branches = await vcs.vcsBranches(directory);
        const status = await vcs.vcsStatus(directory);
        const current = status.branch;
        if (!branches.length) {
          await send("no branches found.");
          return true;
        }
        const lines = branches.map((branch) => (branch === current ? `• <b>${esc(branch)}</b> ✅` : `• <code>${esc(branch)}</code>`));
        await send(`<b>Branches</b>\n${lines.join("\n")}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    if (subcommand === "switch" || subcommand === "checkout" || subcommand === "use") {
      const branch = parts.slice(2).join(" ");
      if (!branch) {
        await send("usage: /branch switch <name>");
        return true;
      }
      try {
        const result = await vcs.vcsSwitch(directory, branch);
        await send(`✅ ${esc(result.output)}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    const branch = parts.slice(1).join(" ");
    try {
      const result = await vcs.vcsSwitch(directory, branch);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_stage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/stage" || text.startsWith("/stage ")) {
    const path = text.slice(6).trim();
    if (!path) {
      await send("usage: /stage <path>");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    try {
      const result = await vcs.vcsStage(directory, path);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_unstage(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/unstage" || text.startsWith("/unstage ")) {
    const path = text.slice(8).trim();
    if (!path) {
      await send("usage: /unstage <path>");
      return true;
    }
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
    try {
      const result = await vcs.vcsUnstage(directory, path);
      await send(`✅ ${esc(result.output)}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  return false;
}

export async function cmd_commit(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/commit" || text.startsWith("/commit ")) {
    const rest = text.slice(7).trim();
    if (!rest) {
      await send("usage: /commit <message>");
      return true;
    }
    if (rest.startsWith("confirm ")) {
      const message = rest.slice(8).trim();
      if (!message) {
        await send("usage: /commit confirm <message>");
        return true;
      }
      const s = await C.restoreActiveSession(chatId, threadId);
      const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();
      try {
        const result = await vcs.vcsCommit(directory, message);
        await send(`✅ ${esc(result.output)}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }
    await send(`Commit message:\n<code>${esc(rest)}</code>\nReply /commit confirm ${esc(rest)} to proceed.`);
    return true;
  }
  return false;
}

export async function cmd_worktree(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  if (text === "/worktrees") {
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY;
    try {
      const list = await C.oc.worktreeList(directory);
      if (!list.length) {
        await send("no worktrees.");
        return true;
      }
      const lines = list.map((w: any) => `• <code>${esc(w.directory ?? w.path ?? "")}</code>`);
      await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
    } catch (err) {
      await send(`❌ ${esc(String(err))}`);
    }
    return true;
  }
  if (text === "/worktree" || text.startsWith("/worktree ")) {
    const args = text.slice("/worktree".length).trim().split(/\s+/).filter(Boolean);
    const subcommand = (args[0] ?? "list").toLowerCase();
    const s = await C.restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? C.config.OPENCODE_DIRECTORY ?? process.cwd();

    if (subcommand === "list" || subcommand === "ls") {
      try {
        const list = await C.oc.worktreeList(directory);
        if (!list.length) {
          await send("no worktrees.");
          return true;
        }
        const lines = list.map((w: any) => `• <code>${esc(w.directory ?? w.path ?? "")}</code>`);
        await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "create" || subcommand === "add") {
      const name = args[1];
      if (!name) {
        await send("usage: /worktree create <name> [branch]");
        return true;
      }
      const branch = args[2];
      try {
        await send("Creating worktree…");
        void C.oc.worktreeCreate(directory, name, branch)
          .then((info) => {
            const created = (info as { directory?: string; path?: string })?.directory ?? (info as { directory?: string; path?: string })?.path ?? name;
            return send(`✅ Worktree created\n<code>${esc(created)}</code>\nUse /worktree switch ${esc(created)}`);
          })
          .catch((err) => send(`❌ ${esc(String(err))}`));
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
      if (args[1] === "confirm") {
        const target = args.slice(2).join(" ");
        if (!target) {
          await send("usage: /worktree remove confirm <directory>");
          return true;
        }
        try {
          await send("Removing worktree…");
          void C.oc.worktreeRemove(directory, target, true)
            .then(() => send(`✅ Worktree removed\n<code>${esc(target)}</code>`))
            .catch((err) => send(`❌ ${esc(String(err))}`));
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        return true;
      }
      const target = args.slice(1).join(" ");
      if (!target) {
        await send("usage: /worktree remove <directory>");
        return true;
      }
      await send(`Remove worktree <code>${esc(target)}</code>?\nReply /worktree remove confirm ${esc(target)} to proceed.`);
      return true;
    }

    if (subcommand === "switch" || subcommand === "use" || subcommand === "cd") {
      const target = args.slice(1).join(" ");
      if (!target) {
        await send("usage: /worktree switch <directory>");
        return true;
      }
      if (!s) {
        await send("no active session.");
        return true;
      }
      try {
        const list = await C.oc.worktreeList(directory);
        const directories = list.map((w: any) => w.directory ?? w.path).filter(Boolean);
        if (!directories.includes(target)) {
          await send(`❌ Not a known worktree:\n<code>${esc(target)}</code>`);
          return true;
        }
        await send("Switching worktree…");
        void C.oc.sessionMove(s.sessionId, target)
          .then(() => {
            s.directory = target;
            return send(`✅ Switched session to\n<code>${esc(target)}</code>`);
          })
          .catch((err) => send(`❌ ${esc(String(err))}`));
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
      return true;
    }

    await send("usage: /worktree [list|create <name> [branch]|remove <directory>|switch <directory>]");
    return true;
  }
  return false;
}

