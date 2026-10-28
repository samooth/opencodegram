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
  const sessionListByChat = new Map<number, string[]>();
  const commandListByChat = new Map<number, string[]>();
  const modelListByChat = new Map<number, Array<{ id: string; providerID: string; variant?: string }>>();
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
      } catch (err) {
        console.error("[topic]", err);
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
      await tg.editRichMessage(chatId, messageId, html, opts);
    } else {
      await tg.sendRichMessage(chatId, html, opts);
    }
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
      const model = s.model ? esc(`${s.model.providerID}/${s.model.id}`) : "";
      return `${start + i + 1}. <b>${title}</b>\n   <code>${esc(s.id)}</code>${model ? " · " + model : ""}`;
    });
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
    await sendOrEditRich(chatId, messageId, `<b>Sessions</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n\n${lines.join("\n\n")}`, { reply_markup: { inline_keyboard: keyboard } });
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
    await tg.sendRichMessage(chatId, `<b>OpenCode commands</b>\n\n${table}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function showModels(chatId: number, page = 0, messageId?: number): Promise<void> {
    const s = sessionsByChat.get(chatId);
    const directory = s?.directory ?? config.OPENCODE_DIRECTORY;
    const res = await oc.client.model.list(directory ? { location: { directory } } as any : undefined);
    const raw = (res as any)?.data ?? (Array.isArray(res) ? res : []);
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
    modelListByChat.set(chatId, list.map((m: any) => ({ id: m.id, providerID: m.providerID, variant: m.variants?.[0]?.id })));
    const lines = slice.map((m: any, i: number) => {
      const name = esc(m.name ?? m.id);
      const variant = m.variants?.length ? ` · ${esc(m.variants.map((v: any) => v.id).join(", "))}` : "";
      const isCurrent = current && current.providerID === m.providerID && current.id === m.id;
      const mark = isCurrent ? " ✅" : "";
      return `${start + i + 1}. <b>${name}</b>${mark}\n   <code>${esc(m.providerID)}/${esc(m.id)}</code>${variant}`;
    });
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
    await sendOrEditRich(chatId, messageId, `<b>Models</b> (${start + 1}-${Math.min(start + pageSize, total)} of ${total})\n${currentLine}${lines.join("\n\n")}`, { reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendPanel(chatId: number): Promise<void> {
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
    await tg.sendRichMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
  }
  const pendingPermissions = new Map<string, { chatId: number; sessionId: string }>(); // requestId -> info

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
          s.draftId = Date.now();
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
          pendingPermissions.set(requestId, { chatId, sessionId });
          const label = p.tool ?? p.action ?? "permission";
          const resource = Array.isArray(p.resources) ? p.resources.join(", ") : (p.message ?? "");
          const threadId = threadBySession.get(sessionId);
          await tg.sendRichMessage(chatId, `<b>Permission requested</b>\n<i>${esc(label)}</i>\n<code>${esc(resource)}</code>`, {
            ...(threadId ? { message_thread_id: threadId } : {}),
            reply_markup: {
              inline_keyboard: [[
                { text: "Allow once", callback_data: `perm:allow:${requestId}` },
                { text: "Deny", callback_data: `perm:deny:${requestId}` },
              ]],
            },
          });
        }

        if (e.type === "session.execution.failed") {
          const sessionId = e.data?.sessionID;
          const chatId = sessionId ? findChatBySession(sessionId) : undefined;
          if (chatId !== undefined) {
            const msg = e.data?.error?.message ?? "execution failed";
            const threadId = sessionId ? threadBySession.get(sessionId) : undefined;
            await tg.sendRichMessage(chatId, `❌ ${esc(msg)}`, threadId ? { message_thread_id: threadId } : {});
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
        const m = data.match(/^perm:(allow|deny):(.+)$/);
        if (m) {
          const decision = m[1] === "allow" ? "once" : "reject";
          const requestId = m[2];
          const info = pendingPermissions.get(requestId);
          if (info) {
            await oc.replyPermission(info.sessionId, requestId, decision);
            await tg.answerCallbackQuery(cq.id, decision === "once" ? "Allowed" : "Denied");
            if (cq.message?.message_id) {
              await tg.editMessageText(info.chatId, cq.message.message_id, `Permission ${decision}: ${requestId}`);
            }
          } else {
            await tg.answerCallbackQuery(cq.id, "Unknown permission");
          }
          pendingPermissions.delete(requestId);
        }

        const chatId = cq.message?.chat?.id ?? cq.from.id;
        const cbData = cq.data ?? "";

        if (cbData === "panel:home" || cbData === "panel:status" || cbData === "panel:help") {
          await tg.answerCallbackQuery(cq.id);
          await sendPanel(chatId);
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
          const s = sessionsByChat.get(chatId);
          if (!model || !s) {
            await tg.answerCallbackQuery(cq.id, "No active session/model");
            continue;
          }
          await tg.answerCallbackQuery(cq.id, "Switching model…");
          try {
            await oc.switchModel(s.sessionId, model);
            if (cq.message?.message_id) {
              await tg.editRichMessage(chatId, cq.message.message_id, `✅ Model switched\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${model.variant ? " (" + esc(model.variant) + ")" : ""}`, { reply_markup: { inline_keyboard: [[{ text: "🧠 Models", callback_data: "panel:models" }, { text: "🏠 Panel", callback_data: "panel:home" }]] } });
            } else {
              await tg.sendRichMessage(chatId, `<b>Model switched</b>\n<code>${esc(model.providerID)}/${esc(model.id)}</code>${model.variant ? " (" + esc(model.variant) + ")" : ""}`, s.threadId ? { message_thread_id: s.threadId } : {});
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
        let s = sessionsByChat.get(chatId);
        if (!s) {
          await createNewSession(chatId);
          s = sessionsByChat.get(chatId)!;
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
      const text = msg.text.trim();

      if (text === "/start" || text === "/help") {
        await sendPanel(chatId);
        continue;
      }

      if (text === "/status") {
        await sendPanel(chatId);
        continue;
      }

      if (text === "/status") {
        const s = sessionsByChat.get(chatId);
        await send(s ? `active session: ${s.sessionId}\ndir: ${s.directory}` : "no active session");
        continue;
      }

      if (text === "/new") {
        await createNewSession(chatId);
        continue;
      }

      if (text === "/stop" || text === "/abort") {
        const s = sessionsByChat.get(chatId);
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

      if (text === "/models") {
        await showModels(chatId, 0);
        continue;
      }

      if (text === "/fork") {
        const s = sessionsByChat.get(chatId);
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
        const s = sessionsByChat.get(chatId);
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
        const s = sessionsByChat.get(chatId);
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
        const s = sessionsByChat.get(chatId);
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
        const s = sessionsByChat.get(chatId);
        if (!s) { await send("no active session."); continue; }
        // Simple confirmation via text; buttons would be better but keep simple.
        await send(`Delete session <code>${esc(s.sessionId)}</code>? Reply /delete confirm to proceed.`);
        continue;
      }

      if (text === "/delete confirm") {
        const s = sessionsByChat.get(chatId);
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
        const s = sessionsByChat.get(chatId);
        if (!s) { await send("no active session."); continue; }
        try {
          const diffs = await oc.diff(s.sessionId);
          if (!diffs.length) { await send("No changes."); continue; }
          const rows = diffs.map((d: any) => `<tr><td><code>${esc(d.file ?? "")}</code></td><td>+${d.additions ?? 0}/-${d.deletions ?? 0}</td><td>${esc(d.status ?? "")}</td></tr>`).join("");
          const details = diffs.map((d: any) => `<details><summary><b>${esc(d.file ?? "")}</b> (+${d.additions ?? 0}/-${d.deletions ?? 0})</summary>\n<pre><code class="language-diff">${esc(d.patch ?? "")}</code></pre>\n</details>`).join("\n");
          await send(`<b>Diff</b>\n<table><tr><th>File</th><th>Changes</th><th>Status</th></tr>${rows}</table>\n\n${details}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/context") {
        const s = sessionsByChat.get(chatId);
        if (!s) { await send("no active session."); continue; }
        try {
          const ctx = await oc.context(s.sessionId);
          const items = Array.isArray(ctx) ? ctx : (ctx as any)?.data ?? [];
          if (!items.length) { await send("No context."); continue; }
          const sliced = items.slice(-10);
          const blocks = sliced.map((m: any) => {
            const role = m.role ?? m.type ?? "msg";
            const text = (m.text ?? m.content ?? "").toString();
            const short = text.slice(0, 120);
            if (text.length <= 120) return `<b>${esc(role)}</b>: ${esc(text)}`;
            return `<details><summary><b>${esc(role)}</b>: ${esc(short)}…</summary>\n<pre>${esc(text)}</pre>\n</details>`;
          });
          await send(`<b>Context (last ${blocks.length})</b>\n\n${blocks.join("\n\n")}`);
        } catch (err) {
          await send(`❌ ${esc(String(err))}`);
        }
        continue;
      }

      if (text === "/compact") {
        const s = sessionsByChat.get(chatId);
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
      let s = sessionsByChat.get(chatId);
      if (!s) {
        await createNewSession(chatId);
        s = sessionsByChat.get(chatId)!;
      }

      const slash = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      const known = new Set(["start", "help", "status", "new", "stop", "abort", "commands"]);
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

      await oc.prompt(s.sessionId, text);
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