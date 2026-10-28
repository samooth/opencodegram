import { loadConfig } from "./config.js";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { TelegramClient } from "./telegram.js";
import { OpenCodeBridge, resolveServerPassword } from "./opencode.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type ChatSession = {
  sessionId: string;
  directory?: string;
  model?: { id: string; providerID: string; variant?: string };
  draftId: number;
  buffer: string;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  threadId?: number;
  userMessageId?: number;
  lastTyping?: number;
};

async function main() {
  const config = loadConfig();
  const tg = new TelegramClient(config.TELEGRAM_BOT_TOKEN);
  const oc = new OpenCodeBridge(config.OPENCODE_BASE_URL, resolveServerPassword());

  const me = await tg.getMe();
  const topicsEnabled = me.has_topics_enabled === true;
  console.log(`[opencodegram] bot: @${me.username ?? me.first_name} (id ${me.id}) topics=${topicsEnabled}`);
  await tg.setMyCommands([
    { command: "start", description: "Welcome and control panel" },
    { command: "help", description: "Show help and panel" },
    { command: "status", description: "Show active session" },
    { command: "sessions", description: "List and switch sessions" },
    { command: "use", description: "Switch to a session by ID" },
    { command: "new", description: "Create a new session" },
    { command: "models", description: "List and switch models" },
    { command: "agents", description: "List and switch agents" },
    { command: "usage", description: "Show usage and cost stats" },
    { command: "vcs", description: "Show VCS status" },
    { command: "worktrees", description: "List worktrees" },
    { command: "commands", description: "List OpenCode commands" },
    { command: "fork", description: "Fork the active session" },
    { command: "rename", description: "Rename the active session" },
    { command: "archive", description: "Archive the active session" },
    { command: "unarchive", description: "Unarchive the active session" },
    { command: "delete", description: "Delete the active session" },
    { command: "diff", description: "Show session diff" },
    { command: "context", description: "Show session context" },
    { command: "compact", description: "Compact session history" },
    { command: "stop", description: "Stop the active turn" },
  ]).catch((err) => console.error("[commands]", err));
  const info = await oc.serverInfo();
  console.log(`[opencodegram] opencode: ${JSON.stringify(info)}`);

  const sessionsByChat = new Map<number, ChatSession>();
  const findChatBySession = (sessionId: string): number | undefined => {
    for (const [cid, s] of sessionsByChat) if (s.sessionId === sessionId) return cid;
    return undefined;
  };
  const audit = (action: string, detail: string) => {
    try {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      const line = `${new Date().toISOString()} ${action} ${detail}\n`;
      writeFileSync(join(process.cwd(), "data", "audit.log"), line, { flag: "a" });
    } catch {
      // ignore
    }
  };
  const getActiveSession = (chatId: number, threadId?: number): ChatSession | undefined => {
    if (threadId) {
      for (const s of sessionsByChat.values()) if (s.threadId === threadId) return s;
    }
    if (sessionsByChat.size === 1) return [...sessionsByChat.values()][0];
    return sessionsByChat.get(chatId);
  };

  const ensureActiveSession = async (chatId: number, threadId?: number): Promise<ChatSession | undefined> => {
    let s = getActiveSession(chatId, threadId);
    if (s) return s;
    // Try to activate the most recent session.
    try {
      const res = await oc.client.session.list({ limit: 1, order: "desc" });
      const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
      if (list.length) {
        await activateSession(chatId, list[0].id);
        s = getActiveSession(chatId, threadId) ?? sessionsByChat.get(chatId);
      }
    } catch {
      // ignore
    }
    return s;
  };
  const sessionListByChat = new Map<number, string[]>();
  const commandListByChat = new Map<number, string[]>();
  const modelListByChat = new Map<number, Array<any>>();
  const pendingModelByChat = new Map<number, any>();
  let modelCache: { time: number; data: any[] } | null = null;
  const THREADS_FILE = join(process.cwd(), "data", "threads.json");
  const threadBySession = new Map<string, number>();
  try {
    if (existsSync(THREADS_FILE)) {
      const raw = readFileSync(THREADS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Record<string, number>;
      for (const [k, v] of Object.entries(parsed)) threadBySession.set(k, v);
    }
  } catch (err) {
    console.error("[threads] load failed", err);
  }
  const saveThreads = () => {
    try {
      mkdirSync(join(process.cwd(), "data"), { recursive: true });
      const obj: Record<string, number> = {};
      for (const [k, v] of threadBySession) obj[k] = v;
      writeFileSync(THREADS_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error("[threads] save failed", err);
    }
  };

  async function createNewSession(chatId: number): Promise<void> {
    const old = sessionsByChat.get(chatId);
    sessionsByChat.delete(chatId);
    const directory = config.OPENCODE_DIRECTORY ?? (await oc.latestSessionDirectory()) ?? process.cwd();
    let model: { id: string; providerID: string; variant?: string } | undefined;
    try {
      const sessions = await oc.client.session.list();
      const list = (sessions as any)?.data ?? (Array.isArray(sessions) ? sessions : []);
      const latest = [...list].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))[0];
      if (latest?.model?.id && latest?.model?.providerID) model = { id: latest.model.id, providerID: latest.model.providerID, variant: latest.model.variant };
    } catch {
      // ignore
    }
    if (!model) model = await oc.defaultModel(directory);
    const session = await oc.createSession({ title: "Telegram session", directory, model, agent: "build" });
    const sessionId = (session as any)?.id ?? (session as any)?.sessionID ?? (session as any)?.data?.id;
    const title = (session as any)?.title ?? "Telegram session";
    const cs: ChatSession = { sessionId, directory, model, draftId: 0, buffer: "", stopped: false };
    if (topicsEnabled) {
      try {
        const topic = await tg.createForumTopic(chatId, title.slice(0, 120));
        cs.threadId = topic.message_thread_id;
        threadBySession.set(sessionId, cs.threadId!);
        saveThreads();
      } catch {
        // Topic creation may fail in non-forum chats; fall back to general chat.
      }
    }
    sessionsByChat.set(chatId, cs);
    await tg.sendRichMessage(chatId, `<b>New session created</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model?.providerID ?? "")}/${esc(model?.id ?? "")}${model?.variant ? " (" + esc(model.variant) + ")" : ""}\ndir: <code>${esc(directory)}</code>`, cs.threadId ? { message_thread_id: cs.threadId } : {});
  }

  async function activateSession(chatId: number, sessionId: string): Promise<void> {
    const session = await oc.client.session.get({ sessionID: sessionId });
    const s = session as any;
    const directory = s?.location?.directory ?? s?.directory;
    const model = s?.model ? { id: s.model.id, providerID: s.model.providerID, variant: s.model.variant } : undefined;
    const old = sessionsByChat.get(chatId);
    // (no-op: sessionsByChat is keyed by chatId)
    const cs: ChatSession = { sessionId, directory, model, draftId: 0, buffer: "", stopped: false };
    if (topicsEnabled) {
      if (threadBySession.has(sessionId)) {
        cs.threadId = threadBySession.get(sessionId);
      } else {
        try {
          const topic = await tg.createForumTopic(chatId, (s.title ?? sessionId).slice(0, 120));
          cs.threadId = topic.message_thread_id;
          threadBySession.set(sessionId, cs.threadId!);
          saveThreads();
        } catch (err) {
          console.error("[topic]", err);
        }
      }
    }
    sessionsByChat.set(chatId, cs);
    await tg.sendRichMessage(chatId, `<b>Active session</b>\n<code>${esc(sessionId)}</code>\nmodel: ${esc(model ? model.providerID + "/" + model.id : "default")}\ndir: <code>${esc(directory ?? "n/a")}</code>`, cs.threadId ? { message_thread_id: cs.threadId } : {});
  }

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

  async function showSessions(chatId: number, page = 0, messageId?: number): Promise<void> {
    const pageSize = 8;
    const res = await oc.client.session.list({ limit: 100, order: "desc" });
    const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
    if (!list.length) {
      await tg.sendRichMessage(chatId, "no sessions found.");
      return;
    }
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    sessionListByChat.set(chatId, slice.map((s: any) => s.id));
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
    await sendOrEditRich(chatId, messageId, `<b>Sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${table}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function showCommands(chatId: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const cmds = await oc.listCommands(directory);
    if (!cmds.length) {
      await tg.sendRichMessage(chatId, "no commands available.");
      return;
    }
    commandListByChat.set(chatId, cmds.map((c: any) => c.name));
    const lines = cmds.map((c: any) => `• <b>/${esc(c.name)}</b>${c.description ? " — " + esc(c.description) : ""}`);
    const tableRows = cmds.map((c: any) => `<tr><td><code>/${esc(c.name)}</code></td><td>${esc(c.description ?? "")}</td></tr>`).join("");
    const table = `<table><tr><th>Command</th><th>Description</th></tr>${tableRows}</table>`;
    const keyboard = cmds.map((c: any) => [{ text: `/${c.name}`, callback_data: `cmd:${c.name}` }]);
    keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
    const botCmds = [
      ["/start", "Welcome and control panel"],
      ["/help", "Show help and panel"],
      ["/status", "Show active session"],
      ["/sessions", "List and switch sessions"],
      ["/models", "List and switch models"],
      ["/agents", "List and switch agents"],
      ["/usage", "Show usage and cost stats"],
      ["/vcs", "Show VCS status"],
      ["/worktrees", "List worktrees"],
      ["/fork", "Fork the active session"],
      ["/rename", "Rename the active session"],
      ["/archive", "Archive the active session"],
      ["/diff", "Show session diff"],
      ["/context", "Show session context"],
      ["/compact", "Compact session history"],
      ["/stop", "Stop the active turn"],
    ];
    const botRows = botCmds.map(([c, d]) => `<tr><td><code>${esc(c)}</code></td><td>${esc(d)}</td></tr>`).join("");
    const botTable = `<table><tr><th>Bot command</th><th>Description</th></tr>${botRows}</table>`;
    await tg.sendRichMessage(chatId, `<b>OpenCode commands</b>\n\n${table}\n\n<b>Bot commands</b>\n\n${botTable}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function showModels(chatId: number, page = 0, messageId?: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    let raw: any[];
    const now = Date.now();
    if (modelCache && now - modelCache.time < 60000) {
      raw = modelCache.data;
    } else {
      const res = await oc.client.model.list(directory ? { location: { directory } } as any : undefined);
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
      await tg.sendRichMessage(chatId, "no models available.");
      return;
    }
    // Flatten: each model entry already has providerID.
    const pageSize = 8;
    const total = list.length;
    const start = page * pageSize;
    const slice = list.slice(start, start + pageSize);
    modelListByChat.set(chatId, list);
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
    await sendOrEditRich(chatId, messageId, `<b>Models</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n${currentLine}${table}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendPanel(chatId: number, threadId?: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
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
      [{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🧠 Models", callback_data: "panel:models" }],
      [{ text: "➕ New", callback_data: "panel:new" }, { text: "⚡ Commands", callback_data: "panel:commands" }],
      [{ text: "📊 Status", callback_data: "panel:status" }, { text: "⏹ Stop", callback_data: "panel:stop" }],
      [{ text: "❓ Help", callback_data: "panel:help" }],
    ];
    await tg.sendRichMessage(chatId, text, { ...(threadId ? { message_thread_id: threadId } : {}), reply_markup: { inline_keyboard: keyboard } });
  }
  const pendingPermissions = new Map<string, { chatId: number; sessionId: string; messageId?: number; decided: boolean; label: string; resource: string }>(); // requestId -> info
  const awaitingReason = new Map<number, string>(); // chatId -> requestId

  const flushDraft = async (chatId: number) => {
    const s = sessionsByChat.get(chatId);
    if (!s) return;
    s.timer = undefined;
    try {
      await tg.sendRichMessageDraftMarkdown(chatId, s.draftId, s.buffer || "…", { can_stop: true, ...(s.threadId ? { message_thread_id: s.threadId } : {}) });
    } catch (err) {
      console.error("[draft]", err);
    }
  };

  // Event stream
  (async () => {
    try {
      for await (const event of oc.events()) {
        const e = event as { type: string; data?: any };
        // Log a compact line for debugging.
        if (e.type.startsWith("session.text") || e.type === "permission.asked" || e.type === "session.idle" || e.type.endsWith("failed") || e.type === "session.step.started" || e.type === "session.step.ended") {
          console.log("[event]", e.type, JSON.stringify(e.data ?? {}).slice(0, 300));
        }

        if (e.type === "session.text.started") {
          const sessionId = e.data?.sessionID ?? e.data?.session?.id;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          s.buffer = "";
          s.draftId = Math.floor(Math.random() * 2147483647) + 1;
          s.stopped = false;
        }

        if (e.type === "session.text.delta") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          const delta = e.data?.delta ?? e.data?.text ?? "";
          s.buffer += delta;
          if (!s.timer) {
            s.timer = setTimeout(() => void flushDraft(chatId), 250);
          }
        }

        if (e.type === "session.text.ended") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId === undefined) continue;
          const s = sessionsByChat.get(chatId);
          if (!s) continue;
          if (s.timer) {
            clearTimeout(s.timer);
            s.timer = undefined;
          }
          if (!s.stopped) {
            await flushDraft(chatId);
            await tg.sendRichMessageMarkdown(chatId, s.buffer || "(empty response)", s.threadId ? { message_thread_id: s.threadId } : {});
          }
          s.buffer = "";
        }

        if (e.type === "permission.asked") {
          const p = e.data ?? {};
          const requestId = p.id;
          const sessionId = p.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId === undefined || !requestId || !sessionId) continue;
          const label = p.tool ?? p.action ?? "permission";
          const resource = Array.isArray(p.resources) ? p.resources.join(", ") : (p.message ?? "");
          const threadId = threadBySession.get(sessionId);
          const sent = await tg.sendRichMessage(chatId, `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>\n\n<i>Expires in 5 minutes</i>`, {
            ...(threadId ? { message_thread_id: threadId } : {}),
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Allow once", callback_data: `perm:allow:${requestId}` },
                  { text: "✅ Always (admin)", callback_data: `perm:always:${requestId}` },
                ],
                [
                  { text: "⛔ Reject", callback_data: `perm:reject:${requestId}` },
                  { text: "🚫 Reject with reason", callback_data: `perm:rejectreason:${requestId}` },
                ],
              ],
            },
          });
          pendingPermissions.set(requestId, { chatId, sessionId, messageId: sent.message_id, decided: false, label, resource });
          // Auto-reject on timeout
          setTimeout(async () => {
            const info = pendingPermissions.get(requestId);
            if (info && !info.decided) {
              info.decided = true;
              try {
                await oc.replyPermission(info.sessionId, requestId, "reject");
              } catch {
                // ignore
              }
              if (info.messageId) {
                await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission auto-rejected (timeout)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
              }
              pendingPermissions.delete(requestId);
            }
          }, 5 * 60 * 1000);
        }

        if (e.type === "permission.replied") {
          const p = e.data ?? {};
          const requestId = p.requestID;
          const info = requestId ? pendingPermissions.get(requestId) : undefined;
          if (info && !info.decided) {
            info.decided = true;
            const reply = p.reply ?? "replied";
            if (info.messageId) {
              await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission ${reply} (via OpenCode)</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
            }
            pendingPermissions.delete(requestId);
          }
        }

        if (e.type === "session.execution.failed") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId !== undefined) {
            const msg = e.data?.error?.message ?? "execution failed";
            const threadId = sessionId ? threadBySession.get(sessionId) : undefined;
            const hint = /rate limit|quota/i.test(msg) ? "\n\nTry switching model with /models." : "";
            await tg.sendRichMessage(chatId, `❌ ${esc(msg)}${esc(hint)}`, threadId ? { message_thread_id: threadId } : {});
          }
        }

        if (e.type === "session.idle") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId !== undefined) {
            const threadId = sessionId ? threadBySession.get(sessionId) : undefined;
            await tg.sendRichMessage(chatId, "✓ session idle", threadId ? { message_thread_id: threadId } : {});
          }
        }
      }
    } catch (err) {
      console.error("[events] stream ended", err);
    }
  })();

  // Telegram polling
  let offset = 0;
  while (true) {
    let updates: any[] = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (err) {
      console.error("[poll]", err);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;

      if (u.stopped_message_generation) {
        const d = u.stopped_message_generation;
        // find session whose draft matches
        for (const [chatId, s] of sessionsByChat) {
          if (s.draftId === d.draft_id) {
            s.stopped = true;
            if (s.timer) {
              clearTimeout(s.timer);
              s.timer = undefined;
            }
            await oc.interrupt(s.sessionId);
            await tg.sendRichMessage(chatId, "⏹ stopped");
          }
        }
        continue;
      }

      if (u.callback_query) {
        const cq = u.callback_query;
        console.log("[telegram] callback from", cq.from?.id, "data=", cq.data, "chat=", cq.message?.chat?.id);
        const userId = cq.from?.id;
        if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
          await tg.answerCallbackQuery(cq.id, "Not authorized");
          continue;
        }
        const data = cq.data ?? "";
        const m = data.match(/^perm:(allow|always|reject|rejectreason):(.+)$/);
        if (m) {
          const action = m[1];
          const requestId = m[2];
          const info = pendingPermissions.get(requestId);
          if (!info) {
            await tg.answerCallbackQuery(cq.id, "Unknown permission");
            continue;
          }
          if (info.decided) {
            await tg.answerCallbackQuery(cq.id, "Already decided");
            continue;
          }
          if (action === "rejectreason") {
            // Set state to capture next text as reason
            awaitingReason.set(info.chatId, requestId);
            setTimeout(() => {
              if (awaitingReason.get(info.chatId) === requestId) awaitingReason.delete(info.chatId);
            }, 2 * 60 * 1000);
            await tg.answerCallbackQuery(cq.id, "Send the reason as a message");
            if (info.messageId) {
              await tg.editRichMessage(info.chatId, info.messageId, `<b>Reject with reason</b>\nSend your reason in the next message.`).catch(() => {});
            }
            continue;
          }
          let decision: "once" | "always" | "reject" = "reject";
          if (action === "allow") decision = "once";
          else if (action === "always") {
            if (config.ADMIN_TELEGRAM_USER_ID && cq.from?.id !== config.ADMIN_TELEGRAM_USER_ID) {
              await tg.answerCallbackQuery(cq.id, "Admin only");
              continue;
            }
            decision = "always";
          }
          info.decided = true;
          await oc.replyPermission(info.sessionId, requestId, decision);
          await tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : decision === "always" ? "Always allowed" : "Rejected");
          if (info.messageId) {
            await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission ${decision}</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>`).catch(() => {});
          }
          pendingPermissions.delete(requestId);
          continue;
        }

        const chatId = cq.message?.chat?.id ?? cq.from.id;
        const cbData = cq.data ?? "";

        if (cbData === "panel:home" || cbData === "panel:status" || cbData === "panel:help") {
          await tg.answerCallbackQuery(cq.id);
          await sendPanel(chatId, cq.message?.message_thread_id);
          continue;
        }
        if (cbData === "panel:sessions") {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, 0, cq.message?.message_id);
          continue;
        }
        if (cbData === "panel:new") {
          await tg.answerCallbackQuery(cq.id, "Creating…");
          await createNewSession(chatId);
          await sendPanel(chatId);
          continue;
        }
        if (cbData === "panel:commands") {
          await tg.answerCallbackQuery(cq.id);
          await showCommands(chatId);
          continue;
        }
        if (cbData === "panel:models") {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, 0, cq.message?.message_id);
          continue;
        }
        if (cbData === "panel:stop") {
          const s = sessionsByChat.get(chatId);
          if (s) {
            await oc.interrupt(s.sessionId);
            await tg.answerCallbackQuery(cq.id, "Stopped");
            await tg.sendRichMessage(chatId, "⏹ stopped");
          } else {
            await tg.answerCallbackQuery(cq.id, "No active session");
          }
          continue;
        }
        const useMatch = cbData.match(/^use:(.+)$/);
        if (useMatch) {
          const sessionId = useMatch[1];
          await tg.answerCallbackQuery(cq.id, "Switching…");
          try {
            await activateSession(chatId, sessionId);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Switched to session\n<code>${esc(sessionId)}</code>`, { reply_markup: { inline_keyboard: [[{ text: "📂 Sessions", callback_data: "panel:sessions" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
            }
          } catch (err) {
            await tg.answerCallbackQuery(cq.id, "Failed");
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }
        const pageMatch = cbData.match(/^sessions:page:(\d+)$/);
        if (pageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showSessions(chatId, parseInt(pageMatch[1], 10), cq.message?.message_id);
          continue;
        }
        const modelsPageMatch = cbData.match(/^models:page:(\d+)$/);
        if (modelsPageMatch) {
          await tg.answerCallbackQuery(cq.id);
          await showModels(chatId, parseInt(modelsPageMatch[1], 10), cq.message?.message_id);
          continue;
        }
        const modelMatch = cbData.match(/^model:(\d+)$/);
        if (modelMatch) {
          const idx = parseInt(modelMatch[1], 10);
          const models = modelListByChat.get(chatId) ?? [];
          const model = models[idx];
          const s = getActiveSession(chatId, cq.message?.message_thread_id) ?? sessionsByChat.get(chatId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No active session/model");
            continue;
          }
          pendingModelByChat.set(chatId, model);
          const variants = Array.isArray(model.variants) ? model.variants : [];
          const keyboard: any[][] = [];
          if (variants.length) {
            for (const v of variants) {
              keyboard.push([{ text: v.id === (model.variants?.[0]?.id) ? `${v.id} (default)` : v.id, callback_data: `variant:${v.id}` }]);
            }
          }
          keyboard.push([{ text: "Default", callback_data: "variant:default" }]);
          keyboard.push([{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
          await tg.answerCallbackQuery(cq.id);
          if (cq.message?.message_id) {
            await tg.editRichMessage(chatId, cq.message.message_id, `Select variant for <b>${esc(model.name ?? model.id)}</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>`, { reply_markup: { inline_keyboard: keyboard } });
          }
          continue;
        }
        const variantMatch = cbData.match(/^variant:(.+)$/);
        if (variantMatch) {
          const variantId = variantMatch[1];
          const model = pendingModelByChat.get(chatId);
          const s = getActiveSession(chatId, cq.message?.message_thread_id) ?? sessionsByChat.get(chatId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No pending model");
            continue;
          }
          const variant = variantId === "default" ? undefined : variantId;
          await tg.answerCallbackQuery(cq.id, "Switching model…");
          try {
            await oc.switchModel(s.sessionId, { id: model.id, providerID: model.providerID, variant });
            pendingModelByChat.delete(chatId);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Model switched\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${variant ? " (" + esc(variant) + ")" : ""}`, { reply_markup: { inline_keyboard: [[{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
            }
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }
        const agentMatch = cbData.match(/^agent:(.+)$/);
        if (agentMatch) {
          const name = agentMatch[1];
          const s = await ensureActiveSession(chatId, cq.message?.message_thread_id);
          if (!s) { await tg.answerCallbackQuery(cq.id, "No active session"); continue; }
          await tg.answerCallbackQuery(cq.id, `Switching to ${name}…`);
          try {
            await oc.switchAgent(s.sessionId, name);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Agent switched to <b>${esc(name)}</b>`, { reply_markup: { inline_keyboard: [[{ text: "🏠 Panel", callback_data: "panel:home" }]] } });
            } else {
              await tg.sendRichMessage(chatId, `Agent switched to ${esc(name)}`);
            }
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }

        const cmdMatch = cbData.match(/^cmd:(.+)$/);
        if (cmdMatch) {
          const name = cmdMatch[1];
          const s = sessionsByChat.get(chatId);
          if (!s) {
            await tg.answerCallbackQuery(cq.id, "No active session");
            continue;
          }
          await tg.answerCallbackQuery(cq.id, `Running /${name}…`);
          try {
            await oc.runCommand(s.sessionId, name, "");
            await tg.sendRichMessage(chatId, `ran /${esc(name)}`);
          } catch (err) {
            await tg.sendRichMessage(chatId, `❌ ${esc(String(err))}`);
          }
          continue;
        }

        continue;
      }

      const msg = u.message;
      if (!msg) continue;
      const userId = msg.from?.id;
      if (config.ADMIN_TELEGRAM_USER_ID && userId !== config.ADMIN_TELEGRAM_USER_ID) {
        await tg.sendRichMessage(msg.chat.id, "Not authorized.");
        continue;
      }

      const chatId = msg.chat.id;
      const replyThread = msg.message_thread_id;
      const send = (html: string, opts: Record<string, unknown> = {}) => tg.sendRichMessage(chatId, html, { ...(replyThread ? { message_thread_id: replyThread } : {}), ...opts });
      console.log("[telegram] message from", userId, chatId, JSON.stringify((msg.text ?? msg.caption ?? "").slice(0, 80)));
      tg.setMessageReaction(chatId, msg.message_id, "👀").catch(() => {});
      tg.sendChatAction(chatId, "typing", replyThread).catch(() => {});
      audit("message", `${userId} ${chatId}: ${(msg.text ?? msg.caption ?? "").slice(0, 120)}`);

      // If we are awaiting a rejection reason, handle it.
      if (msg.text && awaitingReason.has(chatId)) {
        const requestId = awaitingReason.get(chatId)!;
        awaitingReason.delete(chatId);
        const info = pendingPermissions.get(requestId);
        if (info && !info.decided) {
          info.decided = true;
          const reason = msg.text;
          try {
            await oc.replyPermission(info.sessionId, requestId, "reject");
          } catch (err) {
            await send(`❌ ${esc(String(err))}`);
          }
          if (info.messageId) {
            await tg.editRichMessage(info.chatId, info.messageId, `<b>Permission rejected</b>\n<i>${esc(info.label)}</i>\n<code>${esc(info.resource)}</code>\nReason: ${esc(reason)}`).catch(() => {});
          }
          pendingPermissions.delete(requestId);
          await send(`Rejected with reason: ${esc(reason)}`);
        }
        continue;
      }

      // Multimedia handling
      const mediaToAttach: Array<{ uri: string; name: string }> = [];
      const downloadOne = async (fileId: string, suggestedName: string) => {
        const info = await tg.getFile(fileId);
        if (!info.file_path) throw new Error("Telegram did not return a file path");
        const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${info.file_path}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const dir = join("/tmp/opencode/attachments", String(chatId));
        await mkdir(dir, { recursive: true });
        const name = suggestedName || info.file_path.split("/").pop() || `${fileId}.bin`;
        const path = join(dir, name);
        await writeFile(path, buf);
        return { uri: `file://${path}`, name };
      };

      if (Array.isArray(msg.photo) && msg.photo.length) {
        const largest = msg.photo[msg.photo.length - 1];
        mediaToAttach.push(await downloadOne(largest.file_id, `photo_${largest.file_unique_id}.jpg`));
      }
      if (msg.document) {
        mediaToAttach.push(await downloadOne(msg.document.file_id, msg.document.file_name ?? `document_${msg.document.file_unique_id}`));
      }
      if (msg.audio) {
        mediaToAttach.push(await downloadOne(msg.audio.file_id, msg.audio.file_name ?? `audio_${msg.audio.file_unique_id}.mp3`));
      }
      if (msg.voice) {
        mediaToAttach.push(await downloadOne(msg.voice.file_id, `voice_${msg.voice.file_unique_id}.ogg`));
      }
      if (msg.video) {
        mediaToAttach.push(await downloadOne(msg.video.file_id, msg.video.file_name ?? `video_${msg.video.file_unique_id}.mp4`));
      }

      if (mediaToAttach.length) {
        let s = await ensureActiveSession(chatId, replyThread);
        if (!s) {
          await createNewSession(chatId);
          s = getActiveSession(chatId, replyThread) ?? sessionsByChat.get(chatId)!;
        }
        const text = (msg.caption ?? "").trim() || (msg.photo ? "What is in this image?" : "Analyze this file");
        try {
          await oc.prompt(s.sessionId, text, mediaToAttach);
          await send(`📎 Attached ${mediaToAttach.length} file(s) to the session.`, s.threadId ? { message_thread_id: s.threadId } : {});
        } catch (err) {
          await send(`❌ ${esc(String(err))}`, s.threadId ? { message_thread_id: s.threadId } : {});
        }
        continue;
      }

      if (!msg.text) continue;
      let text = (msg.text ?? msg.caption ?? "").trim();
      text = text.replace(/^\/([a-zA-Z0-9_-]+)@\w+/, "/$1");
      // Strip bot mentions anywhere in the text (group usage)
      if (me.username) text = text.replace(new RegExp("@" + me.username, "gi"), "").trim();

      if (text === "/start" || text === "/help") {
        await sendPanel(chatId, replyThread);
        continue;
      }

      if (text === "/status" || text === "/session") {
        await sendPanel(chatId, replyThread);
        continue;
      }

      if (text === "/status") {
        const s = await ensureActiveSession(chatId, replyThread);
        await send(s ? `active session: ${s.sessionId}\ndir: ${s.directory}` : "no active session");
        continue;
      }

      if (text === "/new") {
        await createNewSession(chatId);
        continue;
      }

      if (text === "/stop" || text === "/abort") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) {
          await send("no active session");
          continue;
        }
        try {
          await oc.interrupt(s.sessionId);
          await send("⏹ stopped", s.threadId ? { message_thread_id: s.threadId } : {});
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/commands") {
        await showCommands(chatId);
        continue;
      }

      if (text === "/models" || text === "/model") {
        await showModels(chatId, 0);
        continue;
      }

      if (text === "/agents" || text === "/agent") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        const directory = s.directory ?? config.OPENCODE_DIRECTORY;
        const agents = await oc.listAgents(directory);
        if (!agents.length) { await send("no agents available."); continue; }
        const lines = agents.map((a: any) => `• <b>${esc(a.name ?? a.id)}</b>${a.description ? " — " + esc(a.description) : ""}`);
        const keyboard = agents.map((a: any) => [{ text: a.name ?? a.id, callback_data: `agent:${a.id}` }]);
        keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
        await send(`<b>Agents</b>\n\n${lines.join("\n")}`, { reply_markup: { inline_keyboard: keyboard } });
        continue;
      }

      if (text === "/usage") {
        try {
          const stats = await oc.client.session.stats();
          const data = (stats as any)?.data ?? stats;
          const msg = [
            `<b>Usage</b>`,
            `Sessions: ${data.sessions ?? 0} · Prompts: ${data.prompts ?? 0} · Steps: ${data.steps ?? 0}`,
            `Tokens: in ${(data.tokens?.input ?? 0).toLocaleString()} · out ${(data.tokens?.output ?? 0).toLocaleString()} · reasoning ${(data.tokens?.reasoning ?? 0).toLocaleString()}`,
            `Cost: ${(data.cost ?? 0).toFixed(4)}`,
            `Tools: ${data.tools?.totals?.calls ?? 0} calls (${data.tools?.totals?.succeeded ?? 0} ok, ${data.tools?.totals?.failed ?? 0} failed)`,
          ].join("\n");
          await send(msg);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/vcs") {
        const s = await ensureActiveSession(chatId, replyThread);
        const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
        try {
          const info = await oc.vcsGet(directory);
          const status = await oc.vcsStatus(directory);
          const data = (info as any)?.data ?? info;
          const st = (status as any)?.data ?? status;
          const branch = data?.branch?.current ?? "?";
          const files = Array.isArray(st) ? st.length : (st?.files?.length ?? 0);
          await send(`<b>VCS</b>\nBranch: <code>${esc(branch)}</code>\nChanged files: ${files}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/worktrees") {
        const s = await ensureActiveSession(chatId, replyThread);
        const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
        try {
          const res = await oc.worktreeList(directory);
          const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
          if (!list.length) { await send("no worktrees."); continue; }
          const lines = list.map((w: any) => `• <code>${esc(w.path ?? w.directory ?? "")}</code>`);
          await send(`<b>Worktrees</b>\n${lines.join("\n")}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/fork") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const forked = await oc.forkSession(s.sessionId);
          const newId = (forked as any)?.id ?? (forked as any)?.sessionID ?? (forked as any)?.data?.id;
          await activateSession(chatId, newId);
          await send(`Forked session.\n<code>${esc(s.sessionId)}</code> → <code>${esc(newId)}</code>`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text.startsWith("/rename ")) {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        const title = text.slice(8).trim();
        if (!title) { await send("usage: /rename <title>"); continue; }
        try {
          await oc.renameSession(s.sessionId, title);
          await send(`Renamed session to <b>${esc(title)}</b>.`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/archive") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.archiveSession(s.sessionId, true);
          await send("Session archived.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/unarchive") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.archiveSession(s.sessionId, false);
          await send("Session unarchived.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/delete") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        // Simple confirmation via text; buttons would be better but keep simple.
        await send(`Delete session <code>${esc(s.sessionId)}</code>? Reply /delete confirm to proceed.`);
        continue;
      }

      if (text === "/delete confirm") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.deleteSession(s.sessionId);
          sessionsByChat.delete(chatId);
          await send("Session deleted.");
          await sendPanel(chatId);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/diff") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const diffs = await oc.diff(s.sessionId);
          if (!diffs.length) { await send("No changes."); continue; }
          const rows = diffs.map((d: any) => `<tr><td><code>${esc(d.file ?? "")}</code></td><td>+${d.additions ?? 0}/-${d.deletions ?? 0}</td><td>${esc(d.status ?? "")}</td></tr>`).join("");
          await send(`<b>Diff summary</b>\n<table><tr><th>File</th><th>Changes</th><th>Status</th></tr>${rows}</table>`);
          for (const d of diffs) {
            const patch = (d.patch ?? "").slice(0, 3500);
            await send(`<details><summary><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})</summary>\n<pre><code class="language-diff">${esc(patch)}</code></pre>\n</details>`);
          }
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/context") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          const session = await oc.client.session.get({ sessionID: s.sessionId });
          const modelInfo = await (async () => {
            try {
              const res = await oc.client.model.list();
              const list = (res as any)?.data ?? (Array.isArray(res) ? res : []);
              return list.find((m: any) => m.id === session.model?.id && m.providerID === session.model?.providerID);
            } catch { return null; }
          })();
          const ctxLimit = modelInfo?.limit?.context ?? 0;
          const tokens = session.tokens ?? {};
          const inTok = tokens.input ?? 0;
          const outTok = tokens.output ?? 0;
          const reasonTok = tokens.reasoning ?? 0;
          const cacheRead = tokens.cache?.read ?? 0;
          const ctx = await oc.context(s.sessionId);
          const items = Array.isArray(ctx) ? ctx : (ctx as any)?.data ?? [];
          const meaningful = items.filter((m: any) => {
            const role = m.role ?? m.type;
            if (role === "idle") return false;
            if (role === "assistant") {
              const parts = Array.isArray(m.content) ? m.content : [];
              const hasText = parts.some((p: any) => p.type === "text" && p.text);
              const hasTool = parts.some((p: any) => p.type === "tool");
              return hasText || hasTool;
            }
            return role === "user" || role === "compaction";
          });
          const sliced = meaningful.slice(-6);
          const summaries = sliced.map((m: any) => {
            const role = m.role ?? m.type ?? "msg";
            let text = "";
            if (role === "user") {
              const t = m.text;
              text = typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
            } else if (role === "assistant") {
              const parts = Array.isArray(m.content) ? m.content : [];
              const texts = parts.filter((p: any) => p.type === "text").map((p: any) => {
                const t = p.text;
                return typeof t === "string" ? t : (t ? JSON.stringify(t) : "");
              });
              const tools = parts.filter((p: any) => p.type === "tool").map((p: any) => p.name ?? p.tool ?? "tool");
              text = texts.join(" ").trim();
              if (!text && tools.length) text = "🔧 " + tools.join(", ");
            } else if (role === "compaction") {
              text = (m.summary ?? "").toString().split("\n")[0].slice(0, 120);
            } else {
              text = "";
            }
            text = text.replace(/\s+/g, " ").trim().slice(0, 160);
            const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : role === "compaction" ? "📦" : "•";
            return icon + " <b>" + esc(role) + "</b>: " + esc(text || "(no text)");
          }).filter(Boolean);
          const msg = [
            "<b>🧠 Context</b>",
            "",
            "<b>Model</b>: <code>" + esc(session.model?.providerID ?? "") + "/" + esc(session.model?.id ?? "") + "</code>" + (session.model?.variant ? " (" + esc(session.model.variant) + ")" : ""),
            ctxLimit ? "<b>Window</b>: " + ctxLimit.toLocaleString() + " tokens" : "",
            "<b>Tokens</b>: in " + inTok.toLocaleString() + " · out " + outTok.toLocaleString() + " · reasoning " + reasonTok.toLocaleString() + " · cache " + cacheRead.toLocaleString(),
            "<b>Cost</b>: " + (session.cost ?? 0).toFixed(4),
            "",
            "<b>Recent messages</b>",
            summaries.join("\n") || "(none)",
          ].filter(Boolean).join("\n");
          await send(msg);
        } catch (err) {
          await send("❌ " + esc(String(err)));
        }
        continue;

      }

      if (text === "/compact") {
        const s = await ensureActiveSession(chatId, replyThread);
        if (!s) { await send("no active session."); continue; }
        try {
          await oc.compactSession(s.sessionId);
          await send("Session compacted.");
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/sessions" || text.startsWith("/sessions ")) {
        const arg = text.slice("/sessions".length).trim();
        const page = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg, 10) - 1) : 0;
        await showSessions(chatId, page);
        continue;
      }

      if (text === "/use" || text.startsWith("/use ")) {
        const sessionId = text.slice(4).trim();
        if (!sessionId) {
          await showSessions(chatId, 0);
          continue;
        }
        try {
          await activateSession(chatId, sessionId);
        } catch (err) {
          await send(`failed to switch: ${esc(err instanceof Error ? err.message : String(err))}`);
        }
        continue;
      }

      // Create or reuse session
      let s = await ensureActiveSession(chatId, replyThread);
      if (!s) {
        await createNewSession(chatId);
        s = (await ensureActiveSession(chatId, replyThread))!;
      }

      const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      const known = new Set(["start", "help", "status", "session", "sessions", "new", "stop", "abort", "commands", "model", "models", "agent", "agents", "fork", "rename", "archive", "unarchive", "delete", "diff", "context", "compact", "vcs", "worktrees", "usage"]);
      if (slash && !known.has(slash[1])) {
        const name = slash[1];
        const args = (slash[2] ?? "").trim();
        try {
          await oc.runCommand(s.sessionId, name, args);
          await send(`ran /${name}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}\n\nUse /commands to see available commands.`, { reply_markup: { inline_keyboard: [[{ text: "⚡ Commands", callback_data: "panel:commands" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
        }
        continue;
      }

      try {
        await oc.prompt(s.sessionId, text);
      } catch (err) {
        await send(`❌ ${esc(String(err))}`);
      }
    }
  }
}

const shutdown = (signal: string) => {
  console.log(`[opencodegram] ${signal} received, shutting down`);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => {
  console.error("[opencodegram] unhandled rejection", err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});