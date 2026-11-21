import type { BotDeps } from "../context.js";
import type { TelegramCallbackQuery } from "../telegram.js";
import { esc, threadOpts } from "../util.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function handleTranscriptPage(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^tpage:(.+):(\d+)$/);
  if (!m) return;
  const sessionId = m[1];
  const page = parseInt(m[2], 10);
  // Do not serialize the network round-trips: the card edit is the visible
  // action, and waiting for the ack first made page taps feel slow.
  void deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.transcript.goToPage(chatId, s, page).catch((err) => {
    console.error("[tpage] failed", err);
  });
}

/**
 * P1.1: reading mode and the compact-card overflow menu. Both edit the SAME
 * card message through publishCard, so no new message is ever created.
 */
export async function handleCardView(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, _threadId: number | undefined, _messageId: number | undefined, data: string) {
  const m = data.match(/^(read|back|menu):(.+)$/);
  if (!m) return;
  const action = m[1];
  const s = deps.store.findSessionById(m[2]);
  if (!s) {
    await deps.tg.answerCallbackQuery(cq.id, "La sesión ya no está disponible.", { show_alert: true }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  if (action === "read") s.readingMode = true;
  else if (action === "back") s.readingMode = false;
  else s.cardMenuExpanded = !s.cardMenuExpanded;
  await deps.tg.answerCallbackQuery(cq.id, action === "read" ? "📖 Leyendo…" : action === "back" ? "⬅ Volviendo…" : "⚙️ Opciones").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  void deps.status.publishCard(chatId, s).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

export async function handleHistory(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^hist:(.+?)(?::(html|md|jsonld|jsonl))?$/);
  if (!m) return;
  const sessionId = m[1];
  const format = (m[2] ?? "html") as "html" | "md" | "jsonld" | "jsonl";
  await deps.tg.answerCallbackQuery(cq.id, "Generando historial…").catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  try {
    const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || sessionId;
    const safeName = String(name).replace(/[^\w.-]+/g, "_").slice(0, 40) || sessionId.slice(0, 12);
    const blocks = deps.transcript.blocksOf(s).length;
    // Backfill user prompts from OpenCode's message history so the exports
    // (HTML/Markdown/JSON-LD) show the prompts that started each turn, even
    // for sessions created before per-turn prompt persistence existed.
    const userPrompts: string[] = [];
    try {
      const res = await deps.oc.client.session.context({ sessionID: s.sessionId });
      const msgs = Array.isArray(res) ? res : (((res as { data?: unknown })?.data ?? (res as { messages?: unknown })?.messages) ?? []);
      for (const m of (msgs as Array<Record<string, unknown>>)) {
        if (m?.type !== "user") continue;
        const text = typeof m?.text === "string" ? m.text.trim() : "";
        if (text) userPrompts.push(text);
      }
    } catch (err) {
      console.error("[hist] could not load session context", err);
    }
    let content = "";
    let ext = "html";
    let mimeName = `historial-${safeName}.html`;
    let caption = `📜 Historial (HTML) de <b>${esc(name)}</b> · ${blocks} bloques`;
    if (format === "md") {
      content = deps.transcript.exportTranscriptMarkdown(s, userPrompts);
      ext = "md";
      mimeName = `historial-${safeName}.md`;
      caption = `📝 Historial (Markdown) de <b>${esc(name)}</b> · ${blocks} bloques`;
    } else if (format === "jsonld") {
      content = deps.transcript.exportTranscriptJsonLd(s, userPrompts);
      ext = "jsonld";
      mimeName = `dataset-${safeName}.jsonld`;
      caption = `🧠 Dataset (JSON-LD) de <b>${esc(name)}</b> · ${blocks} bloques`;
    } else if (format === "jsonl") {
      content = deps.transcript.exportTranscriptJsonl(s, userPrompts);
      ext = "jsonl";
      mimeName = `dataset-${safeName}.jsonl`;
      caption = `🧠 Dataset (JSONL) de <b>${esc(name)}</b> · ${blocks} bloques`;
    } else {
      content = deps.transcript.exportTranscriptHtml(s, userPrompts);
      ext = "html";
      mimeName = `historial-${safeName}.html`;
      caption = `📜 Historial (HTML) de <b>${esc(name)}</b> · ${blocks} bloques`;
    }
    const path = join("/tmp/opencode/exports", `${mimeName.replace(/\.[^.]+$/, "")}-${sessionId.slice(0, 8)}.${ext}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    await deps.tg.sendDocument(chatId, path, mimeName, caption, {
      ...(threadId ? { message_thread_id: threadId } : {}),
      parse_mode: "HTML",
    });
    deps.metrics?.inc("history_exports");
  } catch (err) {
    console.error("[hist] export failed", err);
    await deps.tg.sendRichMessage(chatId, `❌ No se pudo generar el historial: ${esc(String(err))}`, threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
}

/**
 * 📥 Export format picker: offers HTML / Markdown / JSON-LD (dataset).
 */
export async function handleHistoryFormatPicker(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^histfmt:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(sessionId);
  if (!s) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const name = (s.topicTitle || "").trim() || s.directory?.split("/").filter(Boolean).pop() || sessionId;
  await deps.tg.sendRichMessage(chatId, `📥 <b>Exportar historial</b> · ${esc(name)}\nElige formato:`, {
    ...threadOpts(threadId),
    reply_markup: {
      inline_keyboard: [
        [{ text: "📜 HTML", callback_data: `hist:${sessionId}:html` }, { text: "📝 Markdown", callback_data: `hist:${sessionId}:md` }],
        [{ text: "🧠 Dataset (JSON-LD)", callback_data: `hist:${sessionId}:jsonld` }, { text: "🧠 Dataset (JSONL)", callback_data: `hist:${sessionId}:jsonl` }],
      ],
    },
  }).catch((err) => console.warn("[callbacks]", err?.message ?? err));
}


export async function handlePagePicker(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const closeMatch = data.match(/^tpick:close:(.+)$/);
  if (closeMatch) {
    // Close: delete the picker message.
    await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    if (cq.message?.message_id) await deps.tg.deleteMessage(chatId, cq.message.message_id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const m = data.match(/^tpick:(.+)$/);
  if (!m) return;
  const sessionId = m[1];
  await deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  const total = deps.transcript.pageCount(s);
  if (total <= 1) {
    await deps.tg.answerCallbackQuery(cq.id, "Solo hay una página").catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  // P1.3: the picker tells the user what the current turn is about.
  const summary = deps.transcript.turnSummary(s).replace(/[<>&]/g, "");
  await deps.tg
    .sendRichMessage(chatId, `⊞ <b>Ir a turno</b> · <i>${total} páginas de ${esc((s.topicTitle || "").trim() || sessionId.slice(0, 12))}</i>\n<i>${esc(summary)}</i>`, {
      ...threadOpts(threadId),
      reply_markup: { inline_keyboard: deps.transcript.pagePickerKeyboard(s, total) },
    })
    .catch((err) => console.warn("[callbacks]", err?.message ?? err));
}

/**
 * Picker navigation: jump to the chosen page on the session card and close
 * the picker message so the chat does not fill with pickers.
 */
export async function handlePickerJump(deps: BotDeps, cq: TelegramCallbackQuery, chatId: number, threadId: number | undefined, messageId: number | undefined, data: string) {
  const m = data.match(/^tpagep:(.+):(\d+)$/);
  if (!m) return;
  const sessionId = m[1];
  const page = parseInt(m[2], 10);
  // Ack and picker cleanup run in parallel with the card edit: they are not
  // prerequisites for navigating and each one costs a Telegram round-trip.
  void deps.tg.answerCallbackQuery(cq.id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  if (cq.message?.message_id) {
    void deps.tg.deleteMessage(chatId, cq.message.message_id).catch((err) => console.warn("[callbacks]", err?.message ?? err));
  }
  const s = deps.store.findSessionById(sessionId);
  if (!s || !deps.transcript) {
    await deps.tg.sendRichMessage(chatId, "⚠️ La sesión ya no está disponible.", threadOpts(threadId)).catch((err) => console.warn("[callbacks]", err?.message ?? err));
    return;
  }
  await deps.transcript.goToPage(chatId, s, page).catch((err) => {
    console.error("[tpagep] failed", err);
  });
}

