type SessionRow = { id?: string; title?: string; model?: { providerID?: string; id?: string }; location?: { directory?: string }; directory?: string };
type CommandRow = { name?: string; description?: string };
type ModelRow = { id?: string; modelID?: string; name?: string; providerID?: string; provider?: string; variants?: Array<{ id?: string } | string>; capabilities?: { input?: string[] } };

import os from "node:os";
import { statfs } from "node:fs/promises";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSession } from "./types.js";
import type { MetricsStore } from "./metrics.js";
import { esc, sessionHeader, threadOpts, projectLabel, clampText } from "./util.js";
import { formatBytes } from "./files/index.js";
import { BOT_COMMANDS } from "./botcommands.js";
import type { InlineKeyboard, InlineButton } from "./apitypes.js";
import { readGpuInfo } from "./resources.js";
import { describeThrottles, throttleTotals } from "./ratethrottle.js";

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
  deliveryBySession?: Map<string, { chatId: number; threadId?: number }>;
  getSessionStatus?: (sessionId: string) => string | undefined;
  metrics: MetricsStore;
  rememberMessageSession?: (chatId: number, messageId: number, sessionId: string) => void;
};

export type Panels = ReturnType<typeof createPanels>;

export function createPanels({ tg, oc, config, getActiveSession, restoreActiveSession, findSessionById, getLastPrompt, modelListByChat, routeKey, chatBySession, deliveryBySession, getSessionStatus, metrics, rememberMessageSession }: PanelsDeps) {
  /** CPU/load/memory/GPU indicators shared by status, panel and ops cards. */
  const hostInfo = () => {
    const cpuCount = os.cpus().length;
    const load = os.loadavg().map((x) => x.toFixed(2)).join(" ");
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    let gpu = "";
    const gpuInfo = readGpuInfo();
    if (gpuInfo) gpu = `${esc(gpuInfo.name)}<br>VRAM: ${gpuInfo.usedMB} MiB/${gpuInfo.totalMB} MiB<br>Load: ${gpuInfo.util}%`;
    return { cpuCount, load, totalMem, freeMem, gpu };
  };
  /** Human-readable bot uptime since process start. */
  const botUptimeText = () => {
    const sec = Math.max(1, Math.round((Date.now() - metrics.startedAt) / 1000));
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };
  /** Model lists depend on the project directory, so the cache is per directory. */
  const modelCache = new Map<string, { time: number; data: ModelRow[] }>();
  const MODEL_CACHE_TTL_MS = 15000;
  const providerListByChat = new Map<string, string[]>();
  const selectedProviderByChat = new Map<string, string | undefined>();
  /** When set, model selection targets this session instead of the route's active session. */
  const modelTargetSessionByScope = new Map<string, string>();
  /**
   * Per-user scope key. In groups several people can browse models in the same
   * topic at once; their pending selections must not overwrite each other.
   */
  const userScope = (chatId: number, threadId: number | undefined, userId?: number) =>
    `${routeKey(chatId, threadId)}#${userId ?? 0}`;

  async function sendOrEditRich(chatId: number, messageId: number | undefined, html: string, opts: Record<string, unknown> = {}, rememberSessionId?: string): Promise<number | undefined> {
    if (messageId) {
      try {
        await tg.editRichMessage(chatId, messageId, html, opts);
        if (rememberSessionId) rememberMessageSession?.(chatId, messageId, rememberSessionId);
        return messageId;
      } catch (err) {
        console.error("[edit]", err);
      }
    }
    const sent = await tg.sendRichMessage(chatId, html, opts).catch((err) => { console.error("[send]", err); return undefined; });
    if (sent?.message_id && rememberSessionId) rememberMessageSession?.(chatId, sent.message_id, rememberSessionId);
    return sent?.message_id;
  }

  async function showDeleteSessions(chatId: number, page = 0, messageId?: number, threadId?: number, filterChatId?: number, onlyRunning?: boolean, _includeArchived?: boolean): Promise<void> {
    const pageSize = 8;
    const res = await oc.client.session.list({ limit: 100, order: "desc", archived: false });
    let list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as SessionRow[];
    if (filterChatId !== undefined && chatBySession) {
      list = list.filter((s: SessionRow) => chatBySession.get(s.id ?? "") === filterChatId);
    }
    if (onlyRunning && getSessionStatus) {
      list = list.filter((s: SessionRow) => getSessionStatus(s.id ?? "") === "busy");
    }
    if (!list.length) {
      await sendOrEditRich(chatId, messageId, "No se encontraron sesiones.", threadOpts(threadId));
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    const lines = slice.map((s: SessionRow, i: number) => {
      const title = esc(s.title ?? "(sin título)");
      const directory = esc(projectLabel(s.location?.directory ?? s.directory));
      const dirSuffix = directory ? ` · ${directory}` : "";
      return `<tr><td>${start + i + 1}</td><td><b>${title}</b></td><td><code>${esc(s.id ?? "")}</code></td><td>${dirSuffix}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Title</th><th>ID</th><th>Dir</th></tr>${lines.join("")}</table>`;
    const keyboard: InlineKeyboard = slice.map((s: SessionRow) => {
      const title = (s.title ?? "(sin título)").slice(0, 40);
      const directory = (s.location?.directory ?? s.directory ?? "").split("/").pop() ?? "";
      const dirSuffix = directory ? ` · ${directory}` : "";
      const label = `🗑 ${(title + dirSuffix).slice(0, 58)}`;
      return [{ text: label, callback_data: `del:${s.id}` }];
    });
    const nav: InlineButton[] = [];
    if (page > 0) nav.push({ text: "◀ Anterior", callback_data: `delsessions:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Siguiente ▶", callback_data: `delsessions:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "📂 Sesiones", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, `<b>Borrar sesiones</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }
  async function showSessions(
    chatId: number,
    page = 0,
    messageId?: number,
    threadId?: number,
    filterChatId?: number,
    onlyRunning?: boolean,
    _opts?: { userId?: number },
  ): Promise<void> {
    const pageSize = 8;
    const list = (await oc.listSessionsCached()) as SessionRow[];
    if (!list.length) {
      await sendOrEditRich(chatId, messageId, "No se encontraron sesiones. Usa /new para crear una.", threadOpts(threadId));
      return;
    }
    // Filter by chat: a session belongs to every chat it was used from, so we
    // look at both the persisted binding and the delivery target.
    const chatsOf = (id: string): number[] => {
      const out = new Set<number>();
      const bound = chatBySession?.get(id);
      if (bound !== undefined) out.add(bound);
      const delivery = deliveryBySession?.get(id);
      if (delivery) out.add(delivery.chatId);
      return [...out];
    };
    let filtered = list;
    if (filterChatId !== undefined) {
      filtered = filtered.filter((s: SessionRow) => chatsOf(String(s.id)).includes(filterChatId));
    }
    if (onlyRunning && getSessionStatus) {
      filtered = filtered.filter((s: SessionRow) => {
        const st = getSessionStatus(String(s.id));
        return st === "busy" || st === "retry";
      });
    }
    if (!filtered.length) {
      const text = onlyRunning ? "No hay sesiones en ejecución." : filterChatId !== undefined ? "No hay sesiones en este chat." : "No se encontraron sesiones.";
      await sendOrEditRich(chatId, messageId, text, threadOpts(threadId));
      return;
    }
    const total = filtered.length;
    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    const activeId = getActiveSession(chatId, threadId)?.sessionId;
    const statusIcon = (id: string) => {
      const st = getSessionStatus ? getSessionStatus(id) : undefined;
      return st === "busy" ? "🔴" : st === "retry" ? "🟡" : st === "idle" ? "🟢" : "⚪";
    };
    const keyboard: InlineKeyboard = slice.map((s: SessionRow) => {
      const title = (s.title ?? "(sin título)").slice(0, 36);
      const model = s.model ? ` · ${s.model.providerID}/${s.model.id}` : "";
      const directory = (s.location?.directory ?? s.directory ?? "").split("/").pop() ?? "";
      const dirSuffix = directory ? ` · ${directory}` : "";
      const mark = activeId && activeId === s.id ? " ✓" : "";
      const label = `${statusIcon(s.id ?? "")} ${title}${model}${dirSuffix}${mark}`.slice(0, 64);
      return [{ text: label, callback_data: `use:${s.id ?? ""}` }];
    });
    const nav: InlineButton[] = [];
    const mode = onlyRunning ? "running" : filterChatId !== undefined ? "group" : "all";
    if (page > 0) nav.push({ text: "◀ Anterior", callback_data: `sessions:page:${page - 1}:${mode}` });
    if (start + pageSize < total) nav.push({ text: "Siguiente ▶", callback_data: `sessions:page:${page + 1}:${mode}` });
    if (nav.length) keyboard.push(nav);
    // Filters keep the current scope so pagination and filters compose.
    const filterRow = [
      { text: mode === "all" ? "✅ All" : "📋 All", callback_data: "sessions:filter:all" },
      { text: mode === "running" ? "✅ Running" : "🔴 Running", callback_data: "sessions:filter:running" },
      { text: mode === "group" ? "✅ Group" : "📁 Group", callback_data: "sessions:filter:group" },
    ];
    keyboard.push(filterRow);
    if (mode !== "all") keyboard.push([{ text: "◀ Todas", callback_data: "sessions:filter:all" }]);
    keyboard.push([{ text: "➕ Nueva sesión", callback_data: "panel:new" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    const activeLine = activeId ? `\nActiva: <code>${esc(activeId.slice(0, 8))}</code>` : "";
    const scopeLine = filterChatId !== undefined ? "\n<i>Mostrando sesiones de este chat</i>" : "";
    const crumb = `<i>🏠 Panel › 📂 Sesiones${mode !== "all" ? ` › ${mode}` : ""}</i>\n`;
    await sendOrEditRich(chatId, messageId, `${crumb}<b>Sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})${activeLine}${scopeLine}\n<i>Selecciona una sesión:</i>`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async function showCommands(chatId: number, threadId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const cmds = (await oc.listCommands(directory)) as CommandRow[];
    if (!cmds.length) {
      await tg.sendRichMessage(chatId, "No hay comandos disponibles.", threadOpts(threadId));
      return;
    }
    const tableRows = cmds.map((c: CommandRow) => `<tr><td><code>/${esc(c.name ?? "")}</code></td><td>${esc(c.description ?? "")}</td></tr>`).join("");
    const table = `<table><tr><th>Command</th><th>Description</th></tr>${tableRows}</table>`;
    const keyboard = cmds.map((c: CommandRow) => [{ text: `/${c.name ?? ""}`, callback_data: `cmd:${c.name ?? ""}` }]);
    keyboard.push([{ text: "📂 Sesiones", callback_data: "panel:sessions" }, { text: "🧠 Modelos", callback_data: "panel:models" }]);
    keyboard.push([{ text: "📊 Estado", callback_data: "panel:status" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    const botCmds: Array<[string, string]> = BOT_COMMANDS.map((c) => [`/${c.command}`, c.description]);

    const botRows = botCmds.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join("");
    const botTable = `<table><tr><th>Bot command</th><th>Description</th></tr>${botRows}</table>`;
    await tg.sendRichMessage(chatId, `<b>Comandos de OpenCode</b>\n\n${table}\n\n<b>Comandos del bot</b>\n\n${botTable}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  /**
   * State of a rendered model panel, keyed by the Telegram message id.
   * Keeping the snapshot per message (instead of a shared index) makes the
   * buttons robust: a list refresh or a second user browsing models in the
   * same topic can no longer make a click apply the wrong model.
   */
  const modelPanels = new Map<number, {
    list: ModelRow[];
    scope: string;
    targetSessionId?: string;
    provider?: string;
    pendingModel?: { id: string; providerID: string; variant?: string };
  }>();

  async function showModels(
    chatId: number,
    page = 0,
    messageId?: number,
    threadId?: number,
    provider?: string,
    targetSessionId?: string | null,
    opts?: { userId?: number },
  ): Promise<void> {
    const scope = userScope(chatId, threadId, opts?.userId);
    if (targetSessionId === null) modelTargetSessionByScope.delete(scope);
    else if (typeof targetSessionId === "string" && targetSessionId) modelTargetSessionByScope.set(scope, targetSessionId);
    const targetId = modelTargetSessionByScope.get(scope);
    let s = targetId ? (findSessionById?.(targetId) ?? getActiveSession(chatId, threadId)) : getActiveSession(chatId, threadId);
    if (!s && !targetId && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    let raw: ModelRow[];
    const now = Date.now();
    // The model list depends on the project directory: cache per directory.
    const cacheKey = directory ?? "__default__";
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.time < MODEL_CACHE_TTL_MS) {
      raw = cached.data;
    } else {
      const res = await oc.client.model.list(directory ? ({ location: { directory } } as unknown as Parameters<typeof oc.client.model.list>[0]) : undefined);
      raw = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as ModelRow[];
      modelCache.set(cacheKey, { time: now, data: raw });
    }
    const list = [...raw].sort((a: ModelRow, b: ModelRow) => {
      const aFree = /free/i.test(a.id ?? "") || /free/i.test(a.name ?? "");
      const bFree = /free/i.test(b.id ?? "") || /free/i.test(b.name ?? "");
      if (aFree !== bFree) return aFree ? -1 : 1;
      return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
    });
    const current = s?.model;
    modelListByChat.set(scope, list as Array<{ id: string; providerID: string; variant?: string; name?: string; variants?: Array<{ id: string }> }>);
    const providers = [...new Set(list.map((m: ModelRow) => m.providerID ?? m.provider ?? "unknown"))].sort();
    const dirLabel = directory ? `<i>dir: <code>${esc(directory)}</code></i>` : "";

    if (!provider) {
      selectedProviderByChat.delete(scope);
      providerListByChat.set(scope, providers);
      if (!providers.length) {
        await sendOrEditRich(chatId, messageId, "no models available.", threadOpts(threadId), s?.sessionId ?? targetId);
        return;
      }
      const total = providers.length;
      const pageSize = 8;
      const start = page * pageSize;
      const slice = providers.slice(start, start + pageSize);
      const targetHeader = s
        ? `${sessionHeader(s)}🧠 <b>Cambiar modelo para esta sesión</b>`
        : `${targetId ? `📌 <b>Sesión</b> · <code>${esc(targetId.slice(0, 8))}</code>\n` : ""}🧠 <b>Cambiar modelo</b>`;
      const lines = slice.map((providerId: string, i: number) => {
        const count = list.filter((m: ModelRow) => (m.providerID ?? m.provider ?? "unknown") === providerId).length;
        const isCurrent = current && current.providerID === providerId;
        const mark = isCurrent ? " ✅" : "";
        return `<tr><td>${start + i + 1}</td><td><b>${esc(providerId)}</b>${mark}</td><td>${count}</td></tr>`;
      });
      const table = `<table><tr><th>#</th><th>Provider</th><th>Models</th></tr>${lines.join("")}</table>`;
      const keyboard: InlineKeyboard = slice.map((providerId: string, i: number) => {
        const count = list.filter((m: ModelRow) => (m.providerID ?? m.provider ?? "unknown") === providerId).length;
        return [{ text: `${providerId} (${count})`.slice(0, 64), callback_data: `prov:${start + i}` }];
      });
      const nav: InlineButton[] = [];
      if (page > 0) nav.push({ text: "◀ Anterior", callback_data: `models:page:${page - 1}` });
      if (start + pageSize < total) nav.push({ text: "Siguiente ▶", callback_data: `models:page:${page + 1}` });
      if (nav.length) keyboard.push(nav);
      keyboard.push([{ text: "❌ Cancelar", callback_data: "modelcancel" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
      const currentLine = current ? `Actual: <code>${esc(current.providerID)}/${esc(current.id)}</code>${current.variant ? " (" + esc(current.variant) + ")" : ""}` : "Actual: <i>default</i>";
      const sentId = await sendOrEditRich(chatId, messageId, `${targetHeader}<i>🏠 Panel › 🧠 Modelos</i>\n<b>Providers</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n${currentLine}\n${dirLabel}\n\n${table}`, {
        ...threadOpts(threadId),
        reply_markup: { inline_keyboard: keyboard },
      }, s?.sessionId ?? targetId);
      if (sentId !== undefined) { modelPanels.set(sentId, { list, scope, targetSessionId: s?.sessionId ?? targetId }); if (modelPanels.size > 100) { const k = modelPanels.keys().next().value; if (k !== undefined) modelPanels.delete(k); } }
      return;
    }

    selectedProviderByChat.set(scope, provider);
    const providerModels = list.filter((m: ModelRow) => (m.providerID ?? m.provider ?? "unknown") === provider);
    const total = providerModels.length;
    const pageSize = 8;
    const start = page * pageSize;
    const slice = providerModels.slice(start, start + pageSize);
    const lines = slice.map((m: ModelRow, i: number) => {
      const name = esc(m.name ?? m.id ?? "");
      const variant = m.variants?.length ? esc(m.variants.map((v) => (typeof v === "string" ? v : v.id ?? "")).join(", ")) : "—";
      const isCurrent = current && current.providerID === (m.providerID ?? m.provider) && current.id === m.id;
      const mark = isCurrent ? " ✅" : "";
      return `<tr><td>${start + i + 1}</td><td><b>${name}</b>${mark}</td><td><code>${esc(m.providerID ?? m.provider ?? "")}/${esc(m.id ?? "")}</code></td><td>${variant}</td></tr>`;
    });
    const table = `<table><tr><th>#</th><th>Model</th><th>ID</th><th>Variants</th></tr>${lines.join("")}</table>`;
    const keyboard: InlineKeyboard = slice.map((m: ModelRow) => {
      const idx = list.indexOf(m);
      const label = `${m.name ?? m.id}`.slice(0, 48);
      return [{ text: label, callback_data: `model:${idx}` }];
    });
    const nav: InlineButton[] = [];
    if (page > 0) nav.push({ text: "◀ Anterior", callback_data: `models:page:${page - 1}` });
    if (start + pageSize < total) nav.push({ text: "Siguiente ▶", callback_data: `models:page:${page + 1}` });
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "◀ Proveedores", callback_data: "prov:back" }, { text: "❌ Cancelar", callback_data: "modelcancel" }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    const currentLine = current ? `Actual: <code>${esc(current.providerID)}/${esc(current.id)}</code>${current.variant ? " (" + esc(current.variant) + ")" : ""}` : "Actual: <i>default</i>";
    const targetHeader = s
      ? `${sessionHeader(s)}🧠 <b>Cambiar modelo para esta sesión</b>`
      : `${targetId ? `📌 <b>Sesión</b> · <code>${esc(targetId.slice(0, 8))}</code>\n` : ""}🧠 <b>Cambiar modelo</b>`;
    const sentId = await sendOrEditRich(chatId, messageId, `${targetHeader}<i>🏠 Panel › 🧠 Modelos › ${esc(provider)}</i>\n<b>Models for ${esc(provider)}</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n${currentLine}\n${dirLabel}\n\n${table}`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: keyboard },
    }, s?.sessionId ?? targetId);
    if (sentId !== undefined) { modelPanels.set(sentId, { list, scope, targetSessionId: s?.sessionId ?? targetId, provider }); if (modelPanels.size > 100) { const k = modelPanels.keys().next().value; if (k !== undefined) modelPanels.delete(k); } }
  }

  async function showStatus(chatId: number, threadId?: number, messageId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const [ocInfo, sessionCount, sessionDetail] = await Promise.all([
      oc.serverInfo().catch(() => null),
      oc.listSessionsCached().then((list) => list.length).catch(() => 0),
      s?.sessionId ? oc.client.session.get({ sessionID: s.sessionId }).catch(() => null) : Promise.resolve(null),
    ]);
    const { cpuCount, load, totalMem, freeMem, gpu } = hostInfo();
    const botUptime = botUptimeText();
    let title = s?.sessionId ? "(loading…)" : "none";
    let modelLine = "—";
    let directory = s?.directory ?? config.OPENCODE_DIRECTORY ?? "—";
    let tokensLine = "—";
    let costLine = "—";
    let updatedLine = "—";
    let turnLine = s?.statusMessageId ? "⏳ active" : "✅ idle";
    if (s?.sessionId) {
      if (sessionDetail) {
        const session = sessionDetail as { title?: string; model?: { id?: string; providerID?: string; variant?: string }; location?: { directory?: string }; directory?: string; tokens?: Record<string, unknown>; cost?: number; time?: { updated?: number } };
        title = session?.title ?? s.sessionId;
        const model = session?.model ?? s.model;
        modelLine = model ? `${esc(model.providerID ?? "")}/${esc(model.id ?? "")}${model.variant ? " (" + esc(model.variant) + ")" : ""}` : "—";
        directory = session?.location?.directory ?? session?.directory ?? directory;
        const tokens = (session?.tokens ?? {}) as Record<string, any>;
        tokensLine = `in ${(tokens.input ?? 0).toLocaleString()} · out ${(tokens.output ?? 0).toLocaleString()} · reasoning ${(tokens.reasoning ?? 0).toLocaleString()}`;
        costLine = (session?.cost ?? 0).toFixed(4);
        if (session?.time?.updated) updatedLine = `<tg-time unix="${Math.floor(session.time.updated / 1000)}" format="wDT">${new Date(session.time.updated).toISOString().slice(0, 16).replace("T", " ")}</tg-time>`;
      } else {
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
    const keyboard: InlineKeyboard = [];
    if (s?.sessionId) keyboard.push([{ text: "🔗 Conectar", callback_data: `connect:${s.sessionId}` }]);
    if (s?.statusMessageId) keyboard.push([{ text: "⏹ Detener", callback_data: "panel:stop" }]);
    keyboard.push([
      { text: "🧠 Modelos", callback_data: s?.sessionId ? `panel:ms:${s.sessionId}` : "panel:models" },
      { text: "📂 Sesiones", callback_data: "panel:sessions" },
    ]);
    keyboard.push([{ text: "🔄 Actualizar", callback_data: "panel:status" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
    await sendOrEditRich(chatId, messageId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } }, s?.sessionId);
  }

  async function sendPanel(chatId: number, threadId?: number): Promise<void> {
    let s = getActiveSession(chatId, threadId);
    if (!s && restoreActiveSession) s = await restoreActiveSession(chatId, threadId);
    const [ocInfo, sessionCount] = await Promise.all([
      oc.serverInfo().catch(() => null),
      oc.listSessionsCached().then((list) => list.length).catch(() => 0),
    ]);
    const { cpuCount, load, totalMem, freeMem, gpu } = hostInfo();
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
      [{ text: "📂 Sesiones", callback_data: "panel:sessions" }, { text: "🧠 Modelos", callback_data: "panel:models" }, { text: "📁 Archivos", callback_data: "panel:files" }],
      [{ text: "➕ Nueva", callback_data: "panel:new" }, { text: "⚡ Comandos", callback_data: "panel:commands" }, { text: "📊 Estado", callback_data: "panel:status" }],
      [{ text: "⏹ Detener", callback_data: "panel:stop" }, { text: "⚙️ Ajustes", callback_data: "panel:settings" }, { text: "❓ Ayuda", callback_data: "panel:help" }],
    ];
    await tg.sendRichMessage(chatId, text, { ...threadOpts(threadId), reply_markup: { inline_keyboard: keyboard } });
  }

  /**
   * Admin operations card: runtime health, Telegram error counters, adaptive
   * throttle state and dead-chat bindings. Shared by /ops and its callbacks.
   */
  async function renderOps(): Promise<{ html: string; keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
    const [ocInfo, disk] = await Promise.all([
      oc.serverInfo().catch(() => null),
      statfs(process.cwd()).catch(() => null),
    ]);
    const botUptime = botUptimeText();
    const mem = process.memoryUsage();
    const diskFree = disk ? formatBytes(disk.bavail * disk.bsize) : "?";
    const throttleTotalsInfo = throttleTotals();
    const counters = Object.entries(metrics.snapshot()).sort((a, b) => b[1] - a[1]);
    const countersHtml = counters.length
      ? counters.slice(0, 14).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v.toLocaleString()}</td></tr>`).join("")
      : `<tr><td colspan="2"><i>sin contadores</i></td></tr>`;
    const throttleLines = describeThrottles();
    const rows = [
      `<tr><td><b>Bot</b></td><td>uptime ${botUptime} · pid ${process.pid} · rss ${(mem.rss / 1024 / 1024).toFixed(0)} MB</td></tr>`,
      `<tr><td><b>Disco</b></td><td>libre ${esc(diskFree)}</td></tr>`,
      ocInfo ? `<tr><td><b>OpenCode</b></td><td>v${esc((ocInfo as { version?: string }).version ?? "")} · pid ${(ocInfo as { pid?: number }).pid ?? ""}</td></tr>` : "",
      `<tr><td><b>Telegram 429</b></td><td>${throttleTotalsInfo.failures} fallos · +${(throttleTotalsInfo.extraMs / 1000).toFixed(0)}s de espera acumulados</td></tr>`,
      throttleLines.length ? `<tr><td><b>Throttles activos</b></td><td>${throttleLines.join("<br>")}</td></tr>` : "",
      metrics.lastError ? `<tr><td><b>Último error</b></td><td>${esc(metrics.lastError.message)} (${new Date(metrics.lastError.time).toISOString().slice(11, 19)})</td></tr>` : "",
    ].filter(Boolean).join("");
    const text = `<h3>🩺 Ops</h3>\n\n<table compact striped bordered>${rows}</table>\n\n<h4>Contadores</h4>\n<table compact striped bordered>${countersHtml}</table>`;
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [{ text: "♻️ Reset métricas", callback_data: "ops:reset" }, { text: "🔄 Refrescar", callback_data: "ops:show" }],
    ];
    return { html: clampText(text, 3900), keyboard };
  }

  return { showSessions, showDeleteSessions, showCommands, showModels, showStatus, sendPanel, renderOps, providerListByChat, selectedProviderByChat, modelTargetSessionByScope, modelPanels, userScope };
}
