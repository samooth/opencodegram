import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { MetricsStore } from "./metrics.js";
import { esc, threadOpts, projectLabel, truncate } from "./util.js";
import { BOT_COMMANDS } from "./botcommands.js";

export type PanelsDeps = {
  tg: TelegramClient;
  oc: OpenCodeBridge;
  config: Config;
  getActiveSession: (chatId: number, threadId?: number) => ChatSession | undefined;
  restoreActiveSession?: (chatId: number, threadId?: number) => Promise<ChatSession | undefined>;
  findSessionById?: (sessionId: string) => ChatSession | undefined;
  getLastPrompt?: (sessionId: string) => string | undefined;
  getLastCot?: (sessionId: string) => string | undefined;
  modelListByChat: Map<string, Array<{ id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id?: string }> }>>;
  routeKey: (chatId: number, threadId?: number) => string;
  chatBySession?: Map<string, number>;
  getSessionStatus?: (sessionId: string) => string | undefined;
  metrics: MetricsStore;
};

export type Panels = ReturnType<typeof createPanels>;

export function createPanels({ tg, oc, config, getActiveSession, restoreActiveSession, findSessionById, getLastPrompt, getLastCot, modelListByChat, routeKey, chatBySession, getSessionStatus, metrics }: PanelsDeps) {
  let modelCache: { time: number; data: any[] } | null = null;
  const providerListByChat = new Map<string, string[]>();
  const selectedProviderByChat = new Map<string, string | undefined>();
  /** When set, model selection targets this session instead of the route's active session. */
  const modelTargetSessionByScope = new Map<string, string>();

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

  async function showDeleteSessions(chatId: number, page = 0, messageId?: number, threadId?: number, filterChatId?: number, onlyRunning?: boolean, includeArchived?: boolean): Promise<void> {
    const pageSize = 8;
    const res = await oc.client.session.list({ limit: 100, order: "desc", archived: false });
    let list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
    if (filterChatId !== undefined && chatBySession) {
      list = list.filter((s: any) => chatBySession.get(s.id) === filterChatId);
    }
    if (onlyRunning && getSessionStatus) {
      const before = list.length;
      list = list.filter((s: any) => getSessionStatus(s.id) === "busy");
    }
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no sessions found.", threadOpts(threadId));
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    const lines = slice.map((s: any, i: number) => {
      const title = esc(s.title ?? "(untitled)");
      const directory = esc(projectLabel(s.location?.directory ?? s.directory));
      const dirSuffix = directory ? ` · ${directory}` : "";
      return `<tr><td>${start + i + 1}</td><td><b>${title}</b></td><td><code>${esc(s.id)}</code></td><td>${dirSuffix}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Title</th><th>ID</th><th>Dir</th></tr>${lines.join("")}</table>`;
    const keyboard: any[][] = slice.map((s: any) => {
      const title = (s.title ?? "(untitled)").slice(0, 40);
      const directory = (s.location?.directory ?? s.directory ?? "").split("/").pop() ?? "";
      const dirSuffix = directory ? ` · ${directory}` : "";
      const label = `🗑 ${(title + dirSuffix).slice(0, 58)}`;
      return [{ text: label, callback_data: `del:${s.id}` }];
    });
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `delsessions:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `delsessions:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, `<b>Delete sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }
  async function showSessions(chatId: number, page = 0, messageId?: number, threadId?: number, filterChatId?: number, onlyRunning?: boolean): Promise<void> {
    const pageSize = 8;
    const list = await oc.listSessionsCached();
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no sessions found. Use /new to create one.", threadOpts(threadId));
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    const activeId = getActiveSession(chatId, threadId)?.sessionId;
    const rows = slice.map((s: any, i: number) => {
      const title = esc(truncate(s.title ?? "(untitled)", 26));
      const model = s.model ? esc(`${s.model.providerID}/${s.model.id}`) : "—";
      const mark = activeId && activeId === s.id ? " ✅" : "";
      const st = getSessionStatus ? getSessionStatus(s.id) : undefined;
      const statusIcon = st === "busy" ? "🔴" : st === "retry" ? "🟡" : st === "idle" ? "🟢" : "⚪";
      const dirLabel = projectLabel(s.location?.directory ?? s.directory);
      const lastPrompt = getLastPrompt ? getLastPrompt(s.id) : undefined;
      const preview = lastPrompt ? `<br/><i>${esc(truncate(lastPrompt, 45))}</i>` : "";
      return `<tr><td>${start + i + 1}</td><td>${statusIcon} <b>${title}</b>${mark}${preview}</td><td><code>${esc(s.id)}</code></td><td>${model}<br/><i>${esc(dirLabel)}</i></td></tr>`;
    });
    const body = `<table><tr><th>#</th><th>Title</th><th>ID</th><th>Model / Dir</th></tr>${rows.join("")}</table>`;
    const keyboard: any[][] = slice.map((s: any, i: number) => {
      const title = (s.title ?? "(untitled)").slice(0, 36);
      const model = s.model ? ` · ${s.model.providerID}/${s.model.id}` : "";
      const directory = (s.location?.directory ?? s.directory ?? "").split("/").pop() ?? "";
      const dirSuffix = directory ? ` · ${directory}` : "";
      const st = getSessionStatus ? getSessionStatus(s.id) : undefined;
      const statusIcon = st === "busy" ? "🔴" : st === "retry" ? "🟡" : st === "idle" ? "🟢" : "⚪";
      const label = `${statusIcon} ${title}${model}${dirSuffix}`.slice(0, 64);
      return [{ text: label, callback_data: `use:${s.id}` }];
    });
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `sessions:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `sessions:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([
      { text: "📋 All", callback_data: "sessions:filter:all" },
      { text: "🔴 Running", callback_data: "sessions:filter:running" },
      { text: "📁 Group", callback_data: "sessions:filter:group" },
    ]);
    keyboard.push([{ text: "➕ New session", callback_data: "panel:new" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, `<b>Sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${body}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showCommands(chatId: number, threadId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
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
    const botCmds: Array<[string, string]> = BOT_COMMANDS.map((c) => [`/${c.command}`, c.description]);

    const botRows = botCmds.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join("");
    const botTable = `<table><tr><th>Bot command</th><th>Description</th></tr>${botRows}</table>`;
    await tg.sendRichMessage(chatId, `<b>OpenCode commands</b>\n\n${table}\n\n<b>Bot commands</b>\n\n${botTable}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showModels(chatId: number, page = 0, messageId?: number, threadId?: number, provider?: string, targetSessionId?: string | null): Promise<void> {
    const scope = routeKey(chatId, threadId);
    if (targetSessionId === null) modelTargetSessionByScope.delete(scope);
    else if (typeof targetSessionId === "string" && targetSessionId) modelTargetSessionByScope.set(scope, targetSessionId);
    const targetId = modelTargetSessionByScope.get(scope);
    let s = targetId ? (findSessionById?.(targetId) ?? getActiveSession(chatId, threadId)) : getActiveSession(chatId, threadId);
    if (!s && !targetId && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    let raw: any[];
    const now = Date.now();
    if (modelCache && now - modelCache.time < 15000) {
      raw = modelCache.data;
    } else {
      const res = await oc.client.model.list(directory ? ({ location: { directory } } as unknown as Parameters<typeof oc.client.model.list>[0]) : undefined);
      raw = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
      modelCache = { time: now, data: raw };
    }
    const list = [...raw].sort((a: any, b: any) => {
      const aFree = /free/i.test(a.id ?? "") || /free/i.test(a.name ?? "");
      const bFree = /free/i.test(b.id ?? "") || /free/i.test(b.name ?? "");
      if (aFree !== bFree) return aFree ? -1 : 1;
      return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
    });
    const current = s?.model;
    modelListByChat.set(scope, list as Array<{ id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id?: string }> }>);
    const providers = [...new Set(list.map((m: any) => m.providerID ?? m.provider ?? "unknown"))].sort();
    const targetNote = targetId ? `\nTarget session: <code>${esc(targetId)}</code>` : "";

    if (!provider) {
      selectedProviderByChat.delete(scope);
      providerListByChat.set(scope, providers);
      if (!providers.length) {
        await tg.sendRichMessage(chatId, "no models available.", threadOpts(threadId));
        return;
      }
      const total = providers.length;
      const pageSize = 8;
      const start = page * pageSize;
      const slice = providers.slice(start, start + pageSize);
      const lines = slice.map((providerId: string, i: number) => {
        const count = list.filter((m: any) => (m.providerID ?? m.provider ?? "unknown") === providerId).length;
        const isCurrent = current && current.providerID === providerId;
        const mark = isCurrent ? " ✅" : "";
        return `<tr><td>${start + i + 1}</td><td><b>${esc(providerId)}</b>${mark}</td><td>${count}</td></tr>`;
      });
      const table = `<table><tr><th>#</th><th>Provider</th><th>Models</th></tr>${lines.join("")}</table>`;
      const keyboard: any[][] = slice.map((providerId: string, i: number) => {
        const count = list.filter((m: any) => (m.providerID ?? m.provider ?? "unknown") === providerId).length;
        return [{ text: `${providerId} (${count})`.slice(0, 64), callback_data: `prov:${start + i}` }];
      });
      const nav: any[] = [];
      if (page > 0) nav.push({ text: "◀ Prev", callback_data: `models:page:${page - 1}` });
      if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `models:page:${page + 1}` });
      if (nav.length) keyboard.push(nav);
      keyboard.push([{ text: "❌ Cancel", callback_data: "modelcancel" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
      const currentLine = current ? `Current: <code>${esc(current.providerID)}/${esc(current.id)}</code>${current.variant ? " (" + esc(current.variant) + ")" : ""}` : "Current: <i>default</i>";
      await sendOrEditRich(chatId, messageId, `<b>Providers</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})${targetNote}\n${currentLine}\n\n${table}`, {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    selectedProviderByChat.set(scope, provider);
    const providerModels = list.filter((m: any) => (m.providerID ?? m.provider ?? "unknown") === provider);
    const total = providerModels.length;
    const pageSize = 8;
    const start = page * pageSize;
    const slice = providerModels.slice(start, start + pageSize);
    const lines = slice.map((m: any, i: number) => {
      const name = esc(m.name ?? m.id);
      const variant = m.variants?.length ? esc(m.variants.map((v: any) => v.id).join(", ")) : "—";
      const isCurrent = current && current.providerID === (m.providerID ?? m.provider) && current.id === m.id;
      const mark = isCurrent ? " ✅" : "";
      return `<tr><td>${start + i + 1}</td><td><b>${name}</b>${mark}</td><td><code>${esc(m.providerID ?? m.provider ?? "")}/${esc(m.id)}</code></td><td>${variant}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Model</th><th>ID</th><th>Variants</th></tr>${lines.join("")}</table>`;
    const keyboard: any[][] = slice.map((m: any) => {
      const idx = list.indexOf(m);
      const label = `${m.name ?? m.id}`.slice(0, 48);
      return [{ text: label, callback_data: `model:${idx}` }];
    });
    const nav: any[] = [];
    if (page > 0) nav.push({ text: "◀ Prev", callback_data: `models:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Next ▶", callback_data: `models:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "◀ Providers", callback_data: "prov:back" }, { text: "❌ Cancel", callback_data: "modelcancel" }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    const currentLine = current ? `Current: <code>${esc(current.providerID)}/${esc(current.id)}</code>${current.variant ? " (" + esc(current.variant) + ")" : ""}` : "Current: <i>default</i>";
    await sendOrEditRich(chatId, messageId, `<b>Models for ${esc(provider)}</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})${targetNote}\n${currentLine}\n\n${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showStatus(chatId: number, threadId?: number, messageId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const ocInfo = await oc.serverInfo().catch(() => null);
    let sessionCount = 0;
    try {
      const list = await oc.listSessionsCached();
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
      if (out) {
        const parts = out.split(",").map((x) => x.trim());
        const name = esc(parts[0] || "GPU");
        const used = esc(parts[1] || "?");
        const total = esc(parts[2] || "?");
        const util = esc(parts[3] || "?");
        gpu = `${name}<br>VRAM: ${used}/${total}<br>Load: ${util}`;
      }
    } catch {
      // no gpu
    }

    const botUptimeSeconds = Math.max(1, Math.round((Date.now() - metrics.startedAt) / 1000));
    const botUptime = `${Math.floor(botUptimeSeconds / 3600)}h ${Math.floor((botUptimeSeconds % 3600) / 60)}m`;
    const lastError = metrics.lastError;

    let title = s?.sessionId ? "(loading…)" : "none";
    let modelLine = "—";
    let directory = s?.directory ?? config.OPENCODE_DIRECTORY ?? "—";
    let tokensLine = "—";
    let costLine = "—";
    let updatedLine = "—";
    let turnLine = s?.statusMessageId ? "⏳ active" : "✅ idle";
    if (s?.sessionId) {
      try {
        const session = (await oc.client.session.get({ sessionID: s.sessionId })) as { title?: string; model?: { id?: string; providerID?: string; variant?: string }; location?: { directory?: string }; directory?: string; tokens?: Record<string, unknown>; cost?: number; time?: { updated?: number } };
        title = session?.title ?? s.sessionId;
        const model = session?.model ?? s.model;
        modelLine = model ? `${esc(model.providerID ?? "")}/${esc(model.id ?? "")}${model.variant ? " (" + esc(model.variant) + ")" : ""}` : "—";
        directory = session?.location?.directory ?? session?.directory ?? directory;
        const tokens = session?.tokens ?? {};
        tokensLine = `in ${(tokens.input ?? 0).toLocaleString()} · out ${(tokens.output ?? 0).toLocaleString()} · reasoning ${(tokens.reasoning ?? 0).toLocaleString()}`;
        costLine = (session?.cost ?? 0).toFixed(4);
        if (session?.time?.updated) updatedLine = `<tg-time unix="${Math.floor(session.time.updated / 1000)}" format="wDT">${new Date(session.time.updated).toISOString().slice(0, 16).replace("T", " ")}</tg-time>`;
      } catch {
        title = s.sessionId;
        if (s.model) modelLine = `${esc(s.model.providerID)}/${esc(s.model.id)}${s.model.variant ? " (" + esc(s.model.variant) + ")" : ""}`;
      }
    }

    const rows = [
      `<tr><td><b>Session</b></td><td><code>${esc(s?.sessionId ?? "none")}</code></td></tr>`,
      s?.sessionId ? `<tr><td><b>Title</b></td><td>${esc(title)}</td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Model</b></td><td>${modelLine}</td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Directory</b></td><td><code>${esc(directory)}</code></td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Tokens</b></td><td>${tokensLine}</td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Cost</b></td><td>${costLine}</td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Updated</b></td><td>${updatedLine}</td></tr>` : "",
      s?.sessionId ? `<tr><td><b>Turn</b></td><td>${turnLine}</td></tr>` : "",
      `<tr><td><b>Bot</b></td><td>uptime ${botUptime} · pid ${process.pid} · updates ${metrics.get("updates")}</td></tr>`,
      metrics.lastError ? `<tr><td><b>Last error</b></td><td>${esc(metrics.lastError.message)} (${new Date(metrics.lastError.time).toISOString().slice(11, 19)})</td></tr>` : "",
      ocInfo ? `<tr><td><b>OpenCode</b></td><td>v${esc((ocInfo as { version?: string }).version ?? "")} · pid ${(ocInfo as { pid?: number }).pid ?? ""} · sessions ${sessionCount}</td></tr>` : "",
      `<tr><td><b>Host</b></td><td>CPU: ${cpuCount} cores<br>Load: ${esc(load)}<br>Mem: ${freeMem}/${totalMem} GB</td></tr>`,
      gpu ? `<tr><td><b>GPU</b></td><td>${gpu}</td></tr>` : "",
    ].filter(Boolean).join("");
    const text = `<h3>📊 Status</h3>\n\n<table compact striped bordered>${rows}</table>`;
    const keyboard: any[][] = [];
    if (s?.sessionId) keyboard.push([{ text: "🔗 Conectar", callback_data: `connect:${s.sessionId}` }]);
    if (s?.statusMessageId) keyboard.push([{ text: "⏹ Stop", callback_data: "panel:stop" }]);
    keyboard.push([{ text: "🔄 Refresh", callback_data: "panel:status" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendPanel(chatId: number, threadId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const ocInfo = await oc.serverInfo().catch(() => null);
    let sessionCount = 0;
    try {
      const list = await oc.listSessionsCached();
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
      if (out) {
        const parts = out.split(",").map((x) => x.trim());
        const name = esc(parts[0] || "GPU");
        const used = esc(parts[1] || "?");
        const total = esc(parts[2] || "?");
        const util = esc(parts[3] || "?");
        gpu = `${name}<br>VRAM: ${used}/${total}<br>Load: ${util}`;
      }
    } catch {
      // no gpu
    }
    const rows = [
      s ? `<tr><td><b>Session</b></td><td><code>${esc(s.sessionId)}</code></td></tr>` : `<tr><td><b>Session</b></td><td>none</td></tr>`,
      s?.model ? `<tr><td><b>Model</b></td><td><code>${esc(s.model.providerID)}/${esc(s.model.id)}</code>${s.model.variant ? " (" + esc(s.model.variant) + ")" : ""}</td></tr>` : "",
      s?.directory ? `<tr><td><b>Directory</b></td><td><code>${esc(s.directory)}</code></td></tr>` : "",
      ocInfo ? `<tr><td><b>OpenCode</b></td><td>v${esc((ocInfo as { version?: string }).version ?? "")} · pid ${(ocInfo as { pid?: number }).pid ?? ""} · sessions ${sessionCount}</td></tr>` : "",
      `<tr><td><b>Host</b></td><td>CPU: ${cpuCount} cores<br>Load: ${esc(load)}<br>Mem: ${freeMem}/${totalMem} GB</td></tr>`,
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

  return { showSessions, showDeleteSessions, showCommands, showModels, showStatus, sendPanel, providerListByChat, selectedProviderByChat, modelTargetSessionByScope };
}
