import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import { esc, threadOpts } from "./util.js";

export type PanelsDeps = {
  tg: TelegramClient;
  oc: OpenCodeBridge;
  config: Config;
  getActiveSession: (chatId: number, threadId?: number) => ChatSession | undefined;
  modelListByChat: Map<string, Array<any>>;
  routeKey: (chatId: number, threadId?: number) => string;
};

export type Panels = ReturnType<typeof createPanels>;

export function createPanels({ tg, oc, config, getActiveSession, modelListByChat, routeKey }: PanelsDeps) {
  let modelCache: { time: number; data: any[] } | null = null;

  async function sendOrEditRich(chatId: number, messageId: number | undefined, html: string, opts: Record<string, unknown> = {}): Promise<void> {
    if (messageId) {
      try {
        await tg.editRichMessage(chatId, messageId, html, opts);
        return;
      } catch (err) {
        console.error("[edit]", err);
      }
    }
    await tg.sendRichMessage(chatId, html, opts);
  }

  async function showSessions(chatId: number, page = 0, messageId?: number, threadId?: number): Promise<void> {
    const pageSize = 8;
    const res = await oc.client.session.list({ limit: 100, order: "desc" });
    const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no sessions found.", threadOpts(threadId));
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    const lines = slice.map((s: any, i: number) => {
      const title = esc(s.title ?? "(untitled)");
      const model = s.model ? esc(`${s.model.providerID}/${s.model.id}`) : "—";
      return `<tr><td>${start + i + 1}</td><td><b>${title}</b></td><td><code>${esc(s.id)}</code></td><td>${model}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Title</th><th>ID</th><th>Model</th></tr>${lines.join("")}</table>`;
    const keyboard: any[][] = slice.map((s: any, i: number) => {
      const title = (s.title ?? "(untitled)").slice(0, 40);
      const model = s.model ? ` · ${s.model.providerID}/${s.model.id}` : "";
      const label = `${start + i + 1}. ${title}${model}`.slice(0, 64);
      return [{ text: label, callback_data: `use:${s.id}` }];
    });
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `sessions:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `sessions:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "➕ New session", callback_data: "panel:new" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, `<b>Sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showCommands(chatId: number, threadId?: number): Promise<void> {
    const s = getActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const cmds = await oc.listCommands(directory);
    if (!cmds.length) {
      await tg.sendRichMessage(chatId, "no commands available.", threadOpts(threadId));
      return;
    }
    const tableRows = cmds.map((c: any) => `<tr><td><code>/${esc(c.name)}</code></td><td>${esc(c.description ?? "")}</td></tr>`).join("");
    const table = `<table><tr><th>Command</th><th>Description</th></tr>${tableRows}</table>`;
    const keyboard = cmds.map((c: any) => [{ text: `/${c.name}`, callback_data: `cmd:${c.name}` }]);
    keyboard.push([{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🧠 Models", callback_data: "panel:models" }]);
    keyboard.push([{ text: "📊 Status", callback_data: "panel:status" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    const botCmds = [
      ["/start", "Welcome and control panel"],
      ["/help", "Show help and panel"],
      ["/status", "Show active session"],
      ["/sessions", "List and switch sessions"],
      ["/use <id>", "Switch to a session by ID"],
      ["/new", "Create a new session"],
      ["/models", "List and switch models"],
      ["/agents", "List and switch agents"],
      ["/commands", "List OpenCode commands"],
      ["/settings", "Bot settings and toggles"],
      ["/file <path>", "Send a local file as a document"],
      ["/ls [path] [-a]", "Browse a directory with buttons"],
      ["/find <text> [-a]", "Search files"],
      ["/read <path> [line]", "Preview a text file"],
      ["/zip [path]", "Archive a file or directory and send it"],
      ["/usage", "Show usage and cost stats"],
      ["/vcs", "Show VCS status"],
      ["/worktrees", "List worktrees"],
      ["/forms", "List pending forms"],
      ["/formreply", "Reply to a form"],
      ["/fork", "Fork the active session"],
      ["/rename <title>", "Rename the active session"],
      ["/archive", "Archive the active session"],
      ["/unarchive", "Unarchive the active session"],
      ["/delete", "Delete the active session"],
      ["/diff", "Show session diff"],
      ["/context", "Show session context"],
      ["/sync", "Sync session history to Telegram"],
      ["/compact", "Compact session history"],
      ["/stop", "Stop the active turn"],
    ];
    const botRows = botCmds.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join("");
    const botTable = `<table><tr><th>Bot command</th><th>Description</th></tr>${botRows}</table>`;
    await tg.sendRichMessage(chatId, `<b>OpenCode commands</b>\n\n${table}\n\n<b>Bot commands</b>\n\n${botTable}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showModels(chatId: number, page = 0, messageId?: number, threadId?: number): Promise<void> {
    const s = getActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    let raw: any[];
    const now = Date.now();
    if (modelCache && now - modelCache.time < 60000) {
      raw = modelCache.data;
    } else {
      const res = await oc.client.model.list(directory ? ({ location: { directory } } as any) : undefined);
      raw = (res as any)?.data ?? (Array.isArray(res) ? res : []);
      modelCache = { time: now, data: raw };
    }
    const list = [...raw].sort((a: any, b: any) => {
      const aFree = /free/i.test(a.id ?? "") || /free/i.test(a.name ?? "");
      const bFree = /free/i.test(b.id ?? "") || /free/i.test(b.name ?? "");
      if (aFree !== bFree) return aFree ? -1 : 1;
      return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
    });
    const current = s?.model;
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no models available.", threadOpts(threadId));
      return;
    }
    const pageSize = 8;
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    modelListByChat.set(routeKey(chatId, threadId), list);
    const lines = slice.map((m: any, i: number) => {
      const name = esc(m.name ?? m.id);
      const variant = m.variants?.length ? esc(m.variants.map((v: any) => v.id).join(", ")) : "—";
      const isCurrent = current && current.providerID === m.providerID && current.id === m.id;
      const mark = isCurrent ? " ✅" : "";
      return `<tr><td>${start + i + 1}</td><td><b>${name}</b>${mark}</td><td><code>${esc(m.providerID)}/${esc(m.id)}</code></td><td>${variant}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Model</th><th>ID</th><th>Variants</th></tr>${lines.join("")}</table>`;
    const keyboard: any[][] = slice.map((m: any, i: number) => {
      const label = `${m.name ?? m.id}`.slice(0, 48);
      return [{ text: label, callback_data: `model:${start + i}` }];
    });
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `models:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `models:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    const currentLine = current ? `Current: <code>${esc(current.providerID)}/${esc(current.id)}</code>${current.variant ? " (" + esc(current.variant) + ")" : ""}\n\n` : "";
    await sendOrEditRich(chatId, messageId, `<b>Models</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n${currentLine}${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function sendPanel(chatId: number, threadId?: number): Promise<void> {
    const s = getActiveSession(chatId, threadId);
    const ocInfo = await oc.serverInfo().catch(() => null);
    let sessionCount = 0;
    try {
      const res = await oc.client.session.list();
      const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
      sessionCount = list.length;
    } catch {
      // ignore
    }
    const cpuCount = os.cpus().length;
    const load = os.loadavg().map((x) => x.toFixed(2)).join(" ");
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    let gpu = "";
    try {
      const out = execFileSync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader"], { timeout: 1500, encoding: "utf8" }).trim().split("\n")[0];
      if (out) gpu = esc(out);
    } catch {
      // no gpu
    }
    const rows = [
      s ? `<tr><td><b>Session</b></td><td><code>${esc(s.sessionId)}</code></td></tr>` : `<tr><td><b>Session</b></td><td>none</td></tr>`,
      s?.model ? `<tr><td><b>Model</b></td><td><code>${esc(s.model.providerID)}/${esc(s.model.id)}</code>${s.model.variant ? " (" + esc(s.model.variant) + ")" : ""}</td></tr>` : "",
      s?.directory ? `<tr><td><b>Directory</b></td><td><code>${esc(s.directory)}</code></td></tr>` : "",
      ocInfo ? `<tr><td><b>OpenCode</b></td><td>v${esc((ocInfo as any).version ?? "")} · pid ${(ocInfo as any).pid ?? ""} · sessions ${sessionCount}</td></tr>` : "",
      `<tr><td><b>Host</b></td><td>${cpuCount} cores · load ${esc(load)} · mem ${freeMem}/${totalMem} GB</td></tr>`,
      gpu ? `<tr><td><b>GPU</b></td><td>${gpu}</td></tr>` : "",
    ].filter(Boolean).join("");
    const text = `<b>OpenCodegram</b>\n\n<table>${rows}</table>`;
    const keyboard = [
      [{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🧠 Models", callback_data: "panel:models" }, { text: "📁 Files", callback_data: "panel:files" }],
      [{ text: "➕ New", callback_data: "panel:new" }, { text: "⚡ Commands", callback_data: "panel:commands" }, { text: "📊 Status", callback_data: "panel:status" }],
      [{ text: "⏹ Stop", callback_data: "panel:stop" }, { text: "❓ Help", callback_data: "panel:help" }],
    ];
    await tg.sendRichMessage(chatId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
  }

  return { showSessions, showCommands, showModels, sendPanel };
}
