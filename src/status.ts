import { t } from "./i18n.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession, CardView } from "./types.js";
import { pendingEditsKey } from "./store.js";
import type { ChatSettings } from "./settings.js";
import { isEditTool, extractEditFile, formatEditDiff, editStats } from "./editutil.js";
import { clampText, colorDiff, copyTextButton, esc, markdownToHtml, sessionHeader, stripRestatedPrompt, threadOpts, toolIcon, truncate, truncateMiddle } from "./util.js";
import { throttleGap } from "./ratethrottle.js";
import { STATUS_BACKGROUND_GAP_MS, STATUS_MIN_UPDATE_GAP_MS } from "./constants.js";
import { dtrace, debugTraceEnabled } from "./debuglog.js";
import { hasPendingUserPrompt } from "./events.js";
import { renderResourceBlock } from "./resources.js";
import { recordTurnStatFromSession } from "./stats.js";
import { closeOpen, createTurnActivity, renderActivity } from "./activity.js";
import { renderTodos } from "./todos.js";
import { capDiff, detectTestRun, getToolSummary, isShellTool, lastReasoning, parseToolInput, relativeEditPath, renderPartialText, renderToolStats, renderVirtualShell, renderThinkingBottom, renderLatestToolBottom, renderTurnReceipt, renderTurnFooter, shortToolArg, summarizeEdits, turnTelemetry, StatusDeps } from "./status-render.js";

export type StatusManager = ReturnType<typeof createStatusManager>;

export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits, rememberCot, rememberStatusMessage, forgetStatusMessage, store, transcript, dashboard, mcpEvents, ocActiveSessionIds }: StatusDeps) {
  /**
   * Live strip for the session card. Latest tool and thought are shown at the
   * bottom of the message (above resource indicators) for readability.
   */
  const renderLiveParts = (s: ChatSession, settings: ChatSettings, unified: boolean): { top: string; bottom: string } => {
    // Compact mode (phone) has a tight budget. Cap each block so ALL sections
    // stay visible instead of slicing the whole strip to its tail (which used
    // to hide reasoning/activity/shell and leave only the partial text).
    const compact = settings.compactCard && !s.cardMenuExpanded && !s.readingMode;
    const reasoningCap = compact ? 220 : 600;
    const activityCap = compact ? 220 : 450;
    const shellCap = compact ? 200 : 400;
    // Blocks hidden via their link give their budget to the answer, so hiding
    // reasoning/thoughts/shell makes more room for the user-visible text.
    const hiddenBudget =
      (s.reasoningCollapsed ? reasoningCap : 0) +
      (s.thoughtsCollapsed ? activityCap : 0) +
      (s.shellCollapsed ? shellCap : 0);
    const basePartial = settings.cardVerbosity === "low" ? 200 : settings.cardVerbosity === "high" ? 800 : (unified ? 600 : 400);
    const partialCap = basePartial + hiddenBudget;
    const lines: string[] = [];
    // Telemetry and the prompt are built here but appended LAST, after the
    // reasoning/thought/shell blocks: the user wants the work first and the
    // clock/context at the bottom (OpenCode-style), not as the first lines.
    const telemetry = turnTelemetry(s, Date.now(), settings.showTokenSpeed);
    // Use the prompt bound to THIS turn by beginTurn(), not the global
    // lastPromptBySession (which can be overwritten by non-user events and
    // showed the assistant's own previous answer in the card).
    const prompt = (s.turnSeq !== undefined ? store?.getTurnPrompt?.(s.sessionId, s.turnSeq) : undefined)
      ?? store?.lastPromptBySession.get(s.sessionId);
    let infoLine = "";
    if (prompt?.trim()) {
      const clock = telemetry.length ? `${esc(telemetry.join(" · "))} · ` : "";
      infoLine = `<p><i>${clock}📝 ${esc(truncateMiddle(prompt.trim(), 100))}</i></p>`;
    } else if (telemetry.length) {
      infoLine = `<p><i>${esc(telemetry.join(" · "))}</i></p>`;
    }
    // Each live section is its OWN collapsible block, so the user can follow
    // reasoning, thoughts and tools independently as they stream in.
    // 🧠 Razonamiento (live reasoning buffer, streamed from the model).
    if (settings.showThinking && s.reasoningBuffer.trim()) {
      const collapsed = s.reasoningCollapsed === true;
      lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:reasoning:${s.sessionId}">🧠 Razonamiento ${collapsed ? "▸" : "▾"}</tg-button></tg-button-row>`);
      if (!collapsed) {
        const tail = s.reasoningBuffer.trim().slice(-reasoningCap);
        lines.push(`<blockquote>${markdownToHtml(tail)}</blockquote>`);
      } else {
        // Keep a one-line preview: a collapsed section with zero content made
        // the user feel reasoning/thoughts were missing entirely.
        const preview = s.reasoningBuffer.trim().split("\n").filter(Boolean).pop() ?? "";
        if (preview) lines.push(`<blockquote expandable>${esc(truncateMiddle(preview, 120))}</blockquote>`);
      }
    }
    // 💭 Pensamiento (compact activity: thoughts, reads, tools).
    const activityBlock = renderActivity(s.activity, settings.cardVerbosity, false, Date.now(), s.activityExpanded === true, settings.showTools);
    if (activityBlock) {
      const collapsed = s.thoughtsCollapsed === true;
      lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:thoughts:${s.sessionId}">💭 Pensamiento ${collapsed ? "▸" : "▾"}</tg-button></tg-button-row>`);
      if (!collapsed) {
        // renderActivity has its own budget; in compact mode cap it here so
        // thoughts stay as a short preview instead of being deleted later.
        lines.push(compact ? clampText(activityBlock, activityCap) : activityBlock);
      } else {
        // Always show at least the counts summary so thoughts are visible
        // even when the detailed rows are folded away.
        const summary = activityBlock.match(/^<p>[\s\S]*?<\/p>/)?.[0] ?? "";
        if (summary) lines.push(summary);
        const preview = s.activity?.entries.filter((e) => e.kind === "thought").slice(-1)[0]?.detail?.trim();
        if (preview) lines.push(`<blockquote expandable><i>${esc(truncateMiddle(preview, 140))}</i></blockquote>`);
      }
    }
    if (!activityBlock && !s.reasoningBuffer.trim()) {
      // Fallback for sessions created before per-turn activity was tracked.
      const thinking = renderThinkingBottom(s, settings);
      if (thinking) lines.push(settings.cardVerbosity === "low" ? `<blockquote expandable>${thinking}</blockquote>` : thinking);
      const shell = renderLatestToolBottom(s, settings);
      if (shell) lines.push(settings.cardVerbosity === "low" ? `<blockquote expandable>${shell}</blockquote>` : shell);
    }
    // Subagents (forks) running in background — new in OpenCode 2.3.0.
    const subs = store?.getActiveSubagents?.(s.sessionId);
    if (subs && subs.total > 0) {
      const label = subs.busy > 0 ? `🤖 ${subs.busy}/${subs.total} subagentes activos` : `🤖 ${subs.total} subagentes`;
      lines.push(`<p><i>${label}</i></p>`);
    }
    // Recent MCP events (experimental, 2.3.0).
    const mcpEvts = mcpEvents?.get(s.sessionId);
    if (mcpEvts?.length) {
      const latest = mcpEvts[mcpEvts.length - 1];
      lines.push(`<blockquote expandable>🔌 MCP · ${esc(latest.server)}\n${esc(latest.text)}</blockquote>`);
    }
    if (s.detached && !s.stopped) {
      lines.push(`<p><i>🔀 En segundo plano · <code>${esc(s.sessionId.slice(0, 12))}…</code> sigue respondiendo aquí. Usa «🔀 Enfocar» para volver a la pestaña.</i></p>`);
    }
    // 4. TODO checklist for the session (from todo.updated events).
    const todosBlock = renderTodos(store?.getTodos?.(s.sessionId) ?? []);
    if (todosBlock) lines.push(todosBlock);
    // ⚡ Virtual shell: ALWAYS visible while working, even when empty, so the
    // user sees the tool transcript slot from the very first token and every
    // new command (read/write/etc.) is captured as it arrives.
    {
      const count = s.toolCallDetails.length;
      if (count) {
        const collapsed = s.shellCollapsed === true;
        const label = collapsed ? `⚡ Shell (${count}) ▸` : `⚡ Shell (${count}) ▾`;
        lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:shell:${s.sessionId}">${label}</tg-button></tg-button-row>`);
        if (!collapsed) {
          const shellText = renderVirtualShell(s.toolCallDetails, shellCap);
          lines.push(`<blockquote><pre language='bash'>${esc(shellText)}</pre></blockquote>`);
        }
      } else {
        lines.push(`<blockquote expandable>⚡ Shell (0)\n<pre language='bash'>$ Trabajando…</pre></blockquote>`);
      }
      // Clear affordance for "send blocking tools to background" (Ctrl+B):
      // a link-style button right under the shell, ONLY while the turn is
      // actively running commands. It disappears on the finished card.
      if (!s.statusFinished && !s.stopped && s.toolCallDetails.length > 0) {
        lines.push('<tg-button-row align="left"><tg-button type="callback_data" style="link" data="panel:bg">Enviar comando a segundo plano</tg-button></tg-button-row>');
      }
    }
    // Partial answer LAST among the work blocks: reasoning → thoughts → shell
    // → answer, the same reading order as the finished card.
    if (settings.showPartialText && s.buffer.trim()) {
      lines.push(renderPartialText(s.buffer, partialCap));
    }
    // Toolcall statistics + clock/prompt live in `bottom`, which the card
    // layout treats as protected tail (it trims history, never this). Putting
    // them here also keeps a SINGLE message id at the very bottom.
    const cardId = s.transcriptMessageId ?? s.statusMessageId;
    const idSuffix = debugTraceEnabled && cardId ? ` · #${cardId}` : "";
    const toolCount = s.toolCallDetails.length;
    const statsLine = (infoLine ? infoLine : "") + `<p><i>🔧 ${toolCount}${idSuffix}</i></p>`;
    // Compact: shrink the strip instead of DELETING sections. Dropping the
    // reasoning/thought lines made the user think those never happened.
    let top = lines.join("");
    if (compact && top.length > 1100) top = clampText(top, 1100);
    return {
      top,
      bottom: statsLine,
    };
  };


  /**
   * Finished card strip. The reading order follows /settings:
   * Razonamiento → Pensamiento → Respuesta, with the "Listo" receipt as a
   * compact footer so the answer is never buried under a status badge.
   */
  const renderDoneStrip = (s: ChatSession, settings: ChatSettings): string => {
    // The answer is the POINT of the turn but must appear AFTER the shell
    // virtual and the "✅ Listo" receipt (per user request). Reasoning and
    // activity stay collapsed context blocks.
    // Only embed the answer if it belongs to THIS turn — a stale answer from
    // the previous turn must not be shown on a new prompt's card.
    const answerIsCurrent = s.lastFinalTurn === undefined || s.lastFinalTurn === s.turnSeq;
    const answerEmbedded = settings.showFinalInCard && answerIsCurrent && !!s.lastFinalText?.trim();
    const lines: string[] = [];
    // One state indicator only: the bold receipt at the bottom. A second
    // "✅ Listo" up here produced the duplicate the user saw.
    // 1) Razonamiento (collapsed, at the top).
    const reasoning = lastReasoning(s);
    if (settings.showThinking && reasoning) {
      const rc = s.reasoningDoneCollapsed === true;
      lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:done:reasoning:${s.sessionId}">🧠 Razonamiento ${rc ? "▸" : "▾"}</tg-button></tg-button-row>`);
      if (!rc) {
        // Each COT entry gets its own native collapsible sub-block.
        const entries = reasoning.split(/\n{2,}---\n{2,}|\n---\n/).filter((e) => e.trim());
        const budget = answerEmbedded ? 1200 : 1800;
        const shown = entries.length > 1 ? entries.map((e) => `<blockquote expandable>${markdownToHtml(truncateMiddle(e.trim(), budget))}</blockquote>`).join("\n") : `<blockquote>${markdownToHtml(truncateMiddle(reasoning.trim(), budget))}</blockquote>`;
        lines.push(shown);
      }
    }

    // 2) Pensamiento (compact activity, collapsed).
    if (settings.showThinking || settings.showLatestThought) {
      const tc = s.thoughtsDoneCollapsed === true;
      lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:done:thoughts:${s.sessionId}">💭 Pensamiento ${tc ? "▸" : "▾"}</tg-button></tg-button-row>`);
      if (!tc) {
        // Keep the actual thought text. "low" verbosity used here made
        // detailCap = 0, so toggling back showed only labels with no content.
        const doneActivity = renderActivity(s.activity, settings.cardVerbosity, true, Date.now(), false, settings.showTools);
        if (doneActivity) lines.push(clampText(doneActivity, 800));
      } else {
        const preview = s.activity?.entries.filter((e) => e.kind === "thought").slice(-1)[0]?.detail?.trim();
        if (preview) lines.push(`<blockquote expandable><i>${esc(truncateMiddle(preview, 140))}</i></blockquote>`);
      }
    }

    // 3) Shell virtual (all toolcalls as `$ <cmd>` lines).
    const virtualDetails = s.toolCallDetails.filter((detail) => !isEditTool(detail.name, detail.input));
    if (settings.showTools && virtualDetails.length) {
      const sc = s.shellDoneCollapsed === true;
      lines.push(`<tg-button-row align="left"><tg-button type="callback_data" style="link" data="block:done:shell:${s.sessionId}">⚡ Shell (${virtualDetails.length}) ${sc ? "▸" : "▾"}</tg-button></tg-button-row>`);
      if (!sc) {
        const shellText = renderVirtualShell(virtualDetails, 500);
        lines.push(`<blockquote><pre language='bash'>${esc(shellText)}</pre></blockquote>`);
      }
    }

    // 4) Respuesta (answer) — visible directly, below the shell.
    const rawAnswer = answerIsCurrent ? (s.lastFinalText?.trim() ?? "") : "";
    if (answerEmbedded && rawAnswer) {
      // The answer is the point of the turn: never truncate it.
      lines.push(`<h4>${t("answer", settings.locale)}</h4>${markdownToHtml(rawAnswer)}`);
    }

    const todosBlock = renderTodos(store?.getTodos?.(s.sessionId) ?? []);
    if (todosBlock) lines.push(todosBlock);
    if (s.detached) lines.push("<p><i>🔀 En segundo plano · otra sesión ocupa la pestaña.</i></p>");
    // Detailed receipt then the compact OpenCode-style footer.
    const prompt = store?.lastPromptBySession.get(s.sessionId);
    const edits = summarizeEdits(s, s.toolCallDetails);
    const test = detectTestRun(s.toolCallDetails);
    lines.push(renderTurnReceipt({
      stopped: s.stopped,
      error: s.lastTurnError,
      prompt,
      edits: edits.files ? edits : undefined,
      test,
      telemetry: turnTelemetry(s, Date.now(), settings.showTokenSpeed),
    }));
    lines.push(renderTurnFooter({
      mode: settings.displayMode === "unified" ? "Unificado" : "Build",
      model: s.model,
      durationMs: s.turnFinishedAt && s.promptStartTime ? s.turnFinishedAt - s.promptStartTime : 0,
      outputTokens: s.turnOutputTokens ?? 0,
      firstStreamedAt: s.turnFirstStreamedAt,
      promptStartTime: s.promptStartTime,
      tools: s.toolCallDetails.length,
    }));
    const doneCardId = s.transcriptMessageId ?? s.statusMessageId;
    if (debugTraceEnabled && doneCardId) lines.push(`<p><i>#${doneCardId}</i></p>`);

    return lines.join("");
  };

  /**
   * Publish the session card (M2). In unified mode the card carries the live
   * content without resource indicators (those live in M1) and streams the
   * latest thought at the bottom for readability.
   */
  const publishCard = async (chatId: number, s: ChatSession): Promise<void> => {
    // Central throttle: EVERY caller (events, callbacks, timers) must respect
    // the per-chat cadence. Without this, publishers bypassed updateStatus's
    // gap and triggered Telegram 429 "retry after" storms.
    const nowPub = Date.now();
    const gap = throttleGap(chatId, STATUS_MIN_UPDATE_GAP_MS);
    if (s._lastPublishAt && nowPub - s._lastPublishAt < gap && !s.statusFinished) {
      // Schedule one coalesced follow-up instead of dropping the update.
      if (!s._publishScheduled) {
        s._publishScheduled = true;
        setTimeout(() => { s._publishScheduled = false; void publishCard(chatId, s).catch(() => {}); }, gap - (nowPub - s._lastPublishAt) + 20);
      }
      return;
    }
    s._lastPublishAt = nowPub;
    dtrace("card", "publish", { sessionId: s.sessionId, chatId, page: s.transcriptPage, turnSeq: s.turnSeq, follow: s.transcriptFollow, finished: s.statusFinished, cardMsgId: s.transcriptMessageId });
    // Cards are published for every chat now (linear mode disabled): one
    // paginated message per session, edited in place, with header/buttons/resources.
    if (!transcript) return;
    const settings = getSettings(chatId);
    const unified = settings.displayMode === "unified";
    const reading = s.readingMode === true;
    const compact = settings.compactCard && !s.cardMenuExpanded && !reading;
    // Trust OpenCode's authoritative active list: a session that is idle there
    // must never show "Trabajando…" or a Stop button, even if local state still
    // has statusFinished=false (e.g. a detached session or a missed text.ended).
    if (!s.statusFinished && !s.stopped && store?.getActiveSession) {
      try {
        const active = await ocActiveSessionIds?.();
        // Do NOT auto-finish while a user prompt is still pending a reply:
        // OpenCode reports a queued session as idle until it starts working,
        // and finishing here would show stale history instead of "working".
        if (active && !active.has(s.sessionId) && !hasPendingUserPrompt(s.sessionId)) {
          s.statusFinished = true;
          if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
          s.statusMessageId = undefined;
          forgetStatusMessage(s.sessionId);
        }
      } catch { /* ignore */ }
    }
    s.cardView = { compact, reading, showResources: !unified && settings.showResourceUsage, unified } satisfies CardView;
    // P1.1: the compact card keeps the receipt readable but never blows past
    // the 1.200-character budget; detail lives in ▾ Más / ▾ Detalles.
    // With the answer already in the strip, skip the duplicate answer block
    // in the transcript page (the full answer stays reachable via 📖 Leer).
    const hideAnswer = settings.showFinalInCard && !!s.lastFinalText?.trim() && !reading;
    // Expanded detail (chosen in Settings) must not be cut by the compact cap.
    const cap = (html: string) => (compact && !hideAnswer && s.activityExpanded !== true && s.statusFinished) ? clampText(html, 650) : html;
    if (reading) {
      await transcript.publish(chatId, s, { ...s.cardView, extraTop: "", working: false, sectionsExpanded: settings.sectionsExpanded });
    } else if (s.statusFinished) {
      await transcript.publish(chatId, s, {
        ...s.cardView,
        sectionsExpanded: settings.sectionsExpanded,
        extraTop: cap(renderDoneStrip(s, settings)),
        working: false,
        answerInCard: hideAnswer,
        // Reasoning, tools and speed are already in the strip; never print them
        // twice (the virtual shell lives in extraTop).
        hideKinds: settings.showTools ? ["thinking", "tools", "meta"] : ["thinking", "meta"],
      });
    } else {
      const parts = renderLiveParts(s, settings, unified);
      await transcript.publish(chatId, s, {
        ...s.cardView,
        sectionsExpanded: settings.sectionsExpanded,
        extraTop: cap(parts.top),
        extraBottom: cap(parts.bottom),
        working: true,
      });
    }
    if (unified && dashboard) {
      const now = Date.now();
      if (!s.dashboardLastUpdate || now - s.dashboardLastUpdate > 6000) {
        s.dashboardLastUpdate = now;
        await dashboard.update(chatId, s.targetThreadId ?? s.threadId, s, { working: !s.statusFinished }).catch((err) => console.warn("[status] dashboard.update failed", err?.message ?? err));
      }
    }
  };

  const startStatus = async (chatId: number, s: ChatSession) => {
    const settings = getSettings(chatId);
    const unified = settings.displayMode === "unified";
    s.statusFinished = false;
    if (s.statusTimer) { clearInterval(s.statusTimer); s.statusTimer = undefined; }
    if (s.statusEditPromise) await s.statusEditPromise.catch(() => {});
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    if (s.deltaFlushTimer) { clearTimeout(s.deltaFlushTimer); s.deltaFlushTimer = undefined; }
    // Bump the generation so late deltas from the previous turn are discarded
    // instead of writing their text into this turn's buffers.
    s.turnGeneration = (s.turnGeneration ?? 0) + 1;
    s.buffer = "";
    s.reasoningBuffer = "";
    // Clear the COT/reasoning history so lastReasoning() cannot show the
    // previous turn's reasoning (the assistant's own answer) on this card.
    s.cotBuffer = "";
    s.cotCount = 0;
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.activity = createTurnActivity();
    // The thinking/shell/tool toggles are the user's choice to see those
    // blocks. Honour them up front so the card never hides details behind
    // "▾ Detalles" when the user already asked to see them in Settings.
    s.activityExpanded = settings.showThinking || settings.showShell || settings.showTools;
    s.readingMode = false;
    s.cardMenuExpanded = false;
    s.lastViewedTurn = undefined;
    // A detail drill-down belongs to one turn's edit snapshot. Keeping the old
    // message id makes later turns edit that stale message with new diffs.
    s.detailMessageId = undefined;
    if (s.resourcesCollapsed === undefined) s.resourcesCollapsed = true;
    s.turnOutputTokens = 0;
    s.turnInputTokens = 0;
    s.turnReasoningTokens = 0;
    s.turnCacheReadTokens = 0;
    s.turnCacheWriteTokens = 0;
    s.turnCost = 0;
    s.turnFirstStreamedAt = undefined;
    s.turnFinishedAt = undefined;
    s.lastTurnError = undefined;
    s.stopped = false;
    s.transcriptPage = undefined;
    // Keep the previous turn's final answer reference so the "Ver completo"
    // button stays available; the card content itself is reset via transcriptPage.
    s.lastFinalMessageId = undefined;
    s.lastFinalTelegramMessageId = undefined;
    s.statusLastUpdate = Date.now();
    // Turn identity and final-delivery markers belong to the TURN, not to the
    // entry point that started it. Reset them here so every path (messages,
    // custom buttons, ensureLiveStatus, retries) gets a fresh dedupe key.
    s.promptStartTime = Date.now();
    s.lastFinalDeliveredPromptStart = undefined;
    s.lastFinalSentAt = undefined;
    s.lastFinalSeparatedPromptStart = undefined;
    s.textEndedHandled = undefined;
    // Keep the previous final-answer message id for rapid-final editing; do
    // not delete it here (deleting on new turn surprised users and removed
    // content they wanted to keep). The new turn's card starts fresh via
    // refloat + pageBreak, so the old tail does not linger in the live view.
    try {
      if (unified && dashboard) {
        await dashboard.ensure(chatId, s.targetThreadId ?? s.threadId, s, { working: true }).catch((err) => console.warn("[status] dashboard.ensure failed", err?.message ?? err));
      }
      if (transcript) {
        // Drain any publish still in flight from the previous turn BEFORE we
        // detach the old card: otherwise that edit lands after refloat and
        // creates a stray/duplicate message with stale content.
        await transcript.awaitDrain?.(s.sessionId);
        // Every turn gets its own card created immediately at the bottom, with
        // live streaming while working. Unified and "única" (refloat) replace
        // the previous card (single message per session); "conservar" keeps the
        // finished card as history; "fija" keeps editing the same card in place.
        store?.beginTurn?.(s);
        s.transcriptFollow = true;
        // Respect the user's cardBehavior. With "tarjeta nueva" (refloat) each
        // turn gets its own message — forcing fixed here broke that choice and
        // left stale message ids that Telegram then refused to edit.
        if (unified || settings.cardBehavior !== "fixed") {
          await transcript.refloat(chatId, s, { keep: settings.cardBehavior === "refloat_keep" });
        }
        await publishCard(chatId, s).catch((err) => console.warn("[status] publishCard failed", err?.message ?? err));
        if (s.transcriptMessageId) {
          s.statusMessageId = s.transcriptMessageId;
          rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, s.transcriptMessageId);
        }
        return;
      }
      const opts = threadOptsFor(s);
      const lines: string[] = [];
      lines.unshift(sessionHeader(s).trimEnd());
      lines.push("⏳ <b>Trabajando…</b>\n<i>Esperando a OpenCode</i>");
      if (settings.showResourceUsage) lines.push("<hr/>", renderResourceBlock(s, { theme: settings.cardTheme }));
      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b: { label: string }, i: number) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const keyboard = [
        [{ text: "⏹ Detener", callback_data: "panel:stop" }],
        ...btnRows,
      ];
      const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()), {
        ...opts,
        reply_markup: { inline_keyboard: keyboard },
      });
      s.statusMessageId = sent.message_id;
      rememberStatusMessage(s.sessionId, chatId, s.targetThreadId ?? s.threadId, sent.message_id);
    } catch (err: unknown) {
      console.error("[status]", err);
    }
  };

  const updateStatus = async (chatId: number, s: ChatSession, force = false) => {
    if (s.statusFinished) return;
    if (!s.statusMessageId && !s.transcriptMessageId) return;
    if (s.statusEditing) { s.statusPendingUpdate = true; return; }
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    const now = Date.now();
    // A session that lost its route (another session took over the tab) keeps
    // updating its card, but at a slower cadence to avoid Telegram rate limits.
    // Forced updates are throttled too in that case. The gap also scales up
    // adaptively while Telegram is rate-limiting this chat (429s).
    const baseGap = s.detached ? STATUS_BACKGROUND_GAP_MS : STATUS_MIN_UPDATE_GAP_MS;
    const minGap = throttleGap(chatId, baseGap);
    if (s.statusLastUpdate && now - s.statusLastUpdate < minGap) {
      if (s.detached || !force) return;
    }
    s.statusEditing = true;
    s.statusLastUpdate = now;
    try {
      if (transcript) {
        await publishCard(chatId, s).catch((err) => console.warn("[status] publishCard failed", err?.message ?? err));
        return;
      }
      const header = sessionHeader(s).trimEnd();
      const statusLine = s.stopped ? "<h4>⏹ Detenido</h4>" : "<h4>⏳ Trabajando…</h4>";
      const telemetry = turnTelemetry(s, Date.now(), settings.showTokenSpeed);
      const telemetryLine = telemetry.length ? `<p><i>${esc(telemetry.join(" · "))}</i></p>` : "";
      const backgroundNote = s.detached && !s.stopped
        ? "<i>🔀 Esta sesión sigue en segundo plano (otra sesión ocupa la pestaña).</i>"
        : "";

      const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));

      let latestToolBlock = "";
      const lastTool = s.toolCallDetails.length ? s.toolCallDetails[s.toolCallDetails.length - 1] : null;
      if (settings.showTools && settings.showLatestTool && lastTool) {
        const toolName = lastTool.name;
        const shell = isShellTool(toolName);
        const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
        const summary = getToolSummary(toolName, lastTool.input);
        const argPart = summary.arg ? ` <code>${esc(shortToolArg(summary.arg, 70))}</code>` : "";
        const parts = [`${statusEmoji} <b>Última herramienta:</b> ${toolIcon(toolName)} <b>${esc(toolName)}</b>${argPart}`];
        if (shell && summary.arg && settings.showToolInput) {
          parts.push(`<pre language='bash'>$ ${esc(truncate(summary.arg, 220))}</pre>`);
        } else if (!shell && settings.showToolInput && !summary.arg && lastTool.input) {
          const p = parseToolInput(lastTool.input);
          if (p) {
            const hint = Object.entries(p)
              .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              .slice(0, 2)
              .map(([k, v]) => `${k}=${truncate(String(v), 50)}`)
              .join(" ");
            if (hint) parts.push(`<i>${esc(hint)}</i>`);
          }
        }
        latestToolBlock = parts.join("\n");
      }

      let latestThoughtBlock = "";
      if (settings.showThinking && settings.showLatestThought && s.reasoningBuffer.trim()) {
        const reasoningLines = s.reasoningBuffer.trim().split(/\n+/).filter(Boolean);
        const lastThought = reasoningLines.length ? reasoningLines[reasoningLines.length - 1] : s.reasoningBuffer.trim();
        latestThoughtBlock = `💭 <b>Último pensamiento:</b>\n<blockquote expandable><mark>${esc(clampText(lastThought, 240))}</mark></blockquote>`;
      }

      let shellBlock = "";
      const virtualDetails = s.toolCallDetails.filter((detail) => !isEditTool(detail.name, detail.input));
      if (settings.showTools && virtualDetails.length) {
        const shellText = renderVirtualShell(virtualDetails, 180);
        shellBlock = `<blockquote${settings.shellExpanded ? "" : " expandable"}>⚡ Shell (${virtualDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`;
      }

      let toolsBlock = "";
      if (settings.showTools && !virtualDetails.length && !editDetails.length && s.toolCalls.length) {
        toolsBlock = "🔧 " + esc(s.toolCalls.slice(-6).join(", "));
      }

      let editsLine = "";
      if (settings.showTools && editDetails.length) {
        const stats = editDetails.map((detail) => {
          const { file, added, removed } = editStats(detail.input);
          return `${file.split("/").pop() ?? file} (+${added}/-${removed})`;
        });
        editsLine = `✏️ Cambios (${editDetails.length}): ${esc(stats.join(", "))}`;
      }

      let partialBlock = "";
      if (settings.showPartialText && s.buffer.trim()) {
        const txt = s.buffer.trim().slice(-Math.min(settings.partialTextLines, 1000));
        partialBlock = "<pre>" + esc(txt) + "</pre>";
      }

      const parts = [
        header,
        statusLine,
        telemetryLine,
        backgroundNote,
        latestToolBlock,
        latestThoughtBlock,
        shellBlock,
        toolsBlock,
        editsLine,
        partialBlock,
      ].filter(Boolean);

      const finalText = clampText(parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd(), 3900);

      const customBtns = store?.getCustomButtons?.(chatId) ?? [];
      const btnRows = customBtns.map((b: { label: string }, i: number) => [{ text: b.label.slice(0, 64), callback_data: `btn:${i}` }]);
      const editKeyboard = [
        [{ text: "⏹ Detener", callback_data: "panel:stop" }],
        ...btnRows,
      ];
      const edit = tg.editRichMessage(chatId, s.statusMessageId!, finalText, {
        ...opts,
        reply_markup: { inline_keyboard: editKeyboard },
      });
      s.statusEditPromise = edit.then(
        () => undefined,
        () => undefined,
      );
      await edit;
    } catch (err: unknown) {
      console.error("[status]", err);
    } finally {
      s.statusEditing = false;
      s.statusEditPromise = undefined;
      if (s.statusPendingUpdate) {
        s.statusPendingUpdate = false;
        // Coalesce queued edits instead of dropping them.
        void updateStatus(chatId, s, true).catch((err) => console.warn("[status]", err?.message ?? err));
      }
    }
  };

  /** Freeze the status card. Stop disappears; thinking/tools stay collapsible. */
  const finishStatus = async (chatId: number, s: ChatSession) => {
    if (s.statusFinished) {
      // Idempotent: step.ended and text.ended may both close the same turn.
      if (s.statusTimer) {
        clearInterval(s.statusTimer);
        s.statusTimer = undefined;
      }
      s.statusMessageId = undefined;
      forgetStatusMessage(s.sessionId);
      return;
    }
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    if (s.deltaFlushTimer) { clearTimeout(s.deltaFlushTimer); s.deltaFlushTimer = undefined; }
    s.statusFinished = true;
    s.turnFinishedAt ??= Date.now();
    if (s.activity) closeOpen(s.activity);
    // Persist one row per finished turn (idempotent upsert; text.ended may
    // enrich it later with the final answer length).
    try {
      const promptText = store?.lastPromptBySession?.get?.(s.sessionId);
      recordTurnStatFromSession(s, chatId, s.targetThreadId ?? s.threadId, {
        promptChars: promptText?.length ?? 0,
        dataDir: store?.dataDir,
      });
    } catch (err) {
      console.warn("[stats] recordTurnStat failed", err);
    }
    if (s.statusEditPromise) {
      await s.statusEditPromise.catch((err) => console.warn("[status]", err?.message ?? err));
      s.statusEditPromise = undefined;
    }
    const settings = getSettings(chatId);
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));

    if (transcript) {
      // Append the turn output to the session transcript: the card is edited
      // in place, so no extra message is sent for thinking or tools.
      const fullThinking = !s.stopped && s.reasoningBuffer.trim() ? s.reasoningBuffer.trim() : "";
      if (fullThinking) {
        // The reasoning is markdown: render it so code blocks and emphasis
        // keep their rich text inside the card.
        const renderThinking = (chunk: string) =>
          `<blockquote expandable>🧠 Razonamiento
${markdownToHtml(chunk)}</blockquote>`;
        // Models often restate the prompt inside their reasoning; showing it
        // again duplicates information the user already sent.
        const cleanThinking = stripRestatedPrompt(fullThinking, store?.lastPromptBySession.get(s.sessionId));
        transcript.addBlock(s, "thinking", renderThinking(cleanThinking), cleanThinking, renderThinking);
        // Persist as COT history (larger cap to avoid losing context).
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + fullThinking;
        if (next.length > 16000) next = next.slice(next.length - 16000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        rememberCot(s.sessionId, next, s.cotCount);
        s.reasoningBuffer = "";
      }
      // NOTE: the virtual shell is rendered in the card strip (renderDoneStrip)
      // so it updates in place instead of being duplicated here. Only edits
      // get their own transcript block (diffs).
      // Drop any stale page the user was browsing mid-turn so the finished
      // answer is the one on screen (no need to tap "⏭ Última").
      s.transcriptFollow = true;
      s.transcriptPage = undefined;
      const unified = settings.displayMode === "unified";
      // Edits live INSIDE the session card as a transcript block: one message
      // per turn, no separate "Edits" message to navigate back from. The same
      // table + per-file expandable diff presentation is kept. The block is
      // appended BEFORE publishing so the finished card already shows it.
      let editSnapshot: Array<ChatSession["toolCallDetails"][number]> | undefined;
      if (editDetails.length) {
        const editLines: string[] = [];
        const tableRows: string[] = [];
        const plainFiles: string[] = [];
        for (const detail of editDetails) {
          const file = relativeEditPath(s, extractEditFile(detail.input) ?? `edit ${editLines.length + 1}`);
          const { added, removed } = editStats(detail.input);
          tableRows.push(`<tr><td><code>${esc(file)}</code></td><td>+${added}</td><td>-${removed}</td></tr>`);
          const diff = formatEditDiff(detail.input, settings.diffStyle, s.directory);
          const capped = capDiff(diff, 12);
          editLines.push(`✏️ <b>${esc(file)}</b>${diff.trim() ? `\n<blockquote expandable><pre><code class="language-diff">${colorDiff(capped)}</code></pre></blockquote>` : ""}`);
          plainFiles.push(file);
        }
        const table = `<table><tr><th>Archivo</th><th>+</th><th>-</th></tr>${tableRows.join("")}</table>`;
        const html = `<h4>✏️ Cambios (${editDetails.length})</h4>\n${table}\n${editLines.join("\n")}`;
        editSnapshot = editDetails.map((d) => ({ ...d }));
        transcript.addBlock(s, "tools", html, `Cambios (${editDetails.length}): ${plainFiles.join(", ")}`);
      }
      // Keep the finished card attached: it holds the final answer and stays
      // navigable (pagination). The next turn start decides whether it is
      // replaced (única), preserved (conservar) or kept editing in place (fija).
      await publishCard(chatId, s).catch((err) => console.warn("[status] publishCard failed", err?.message ?? err));
      // The card stays alive for pagination; only the live status ends.
      s.statusMessageId = undefined;
      forgetStatusMessage(s.sessionId);
      if (unified && dashboard) {
        await dashboard.update(chatId, s.targetThreadId ?? s.threadId, s, { working: false }).catch((err) => console.warn("[status] dashboard.update failed", err?.message ?? err));
      }
      // Register the snapshot under the id the card ended up with: publishing
      // may have created a new card, and the per-file buttons read it by
      // chat+message.
      const finalCardId = s.transcriptMessageId;
      if (editSnapshot && finalCardId) {
        store?.rememberPendingEdits(chatId, finalCardId, s.sessionId, editSnapshot);
        pendingEdits.set(pendingEditsKey(chatId, finalCardId), s);
      }
      return;
    }

    forgetStatusMessage(s.sessionId);
    if (s.statusMessageId) {
      const messageId = s.statusMessageId;
      s.expandedEditIndex = undefined;
      if (editDetails.length) {
        pendingEdits.set(pendingEditsKey(chatId, messageId), s);
        store?.rememberPendingEdits(chatId, messageId, s.sessionId, editDetails.map((d) => ({ ...d })));
      }
      const fullThinking = (!s.stopped && s.reasoningBuffer.trim()) ? s.reasoningBuffer.trim() : "";
      const text = clampText(renderFinished(s, settings, !fullThinking || !settings.showThinking));
      const keyboard = finishedKeyboard(editDetails, undefined, s, messageId);
      await tg
        .editRichMessage(chatId, messageId, text, {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: keyboard },
        })
        .catch((err) => console.error("[status] finish edit FAILED", messageId, err));
      if (fullThinking) {
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + fullThinking;
        if (next.length > 16000) next = next.slice(next.length - 16000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        rememberCot(s.sessionId, next, s.cotCount);
        s.reasoningBuffer = "";
      }
      s.statusMessageId = undefined;
    }
  };

  const renderFinished = (target: ChatSession, settings: ChatSettings, inlineThinking = true): string => {
    const previousCot = target.cotBuffer?.trim() ?? "";
    const lines: string[] = [];
    lines.unshift(sessionHeader(target, undefined, settings.showSessionNameInStatus).trimEnd());
    if (settings.showCot && previousCot) {
      const cot = previousCot.slice(-3500);
      lines.push(`<blockquote expandable>🧾 COT (${target.cotCount ?? 0})
${esc(cot)}</blockquote>`);
    }
    // Reading order: Razonamiento → Pensamiento → Respuesta. The receipt goes
    // at the very end so the answer is the last thing the user reads.
    if (!settings.compactFinal) {
      if (inlineThinking && settings.showThinking && !target.stopped && target.reasoningBuffer.trim()) {
        const r = target.reasoningBuffer.trim();
        lines.push(`<blockquote expandable>🧠 Razonamiento
${esc(r)}</blockquote>`);
      }
      if (settings.showThinking || settings.showLatestThought) {
        // Finished card: detail always collapsed, independent of the profile.
        const activityBlock = renderActivity(target.activity, settings.cardVerbosity, true, Date.now(), false, settings.showTools);
        if (activityBlock) lines.push(activityBlock);
      }
      const virtualDetails = target.toolCallDetails.filter((detail) => !isEditTool(detail.name, detail.input));
      const editDetails = target.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (settings.showTools && virtualDetails.length) {
        const shellText = renderVirtualShell(virtualDetails, 500);
        lines.push(`<blockquote${settings.shellExpanded ? "" : " expandable"}>⚡ Shell (${virtualDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`);
      }
      if (settings.showTools && editDetails.length) {
        const editLines = [`✏️ Cambios: ${editDetails.length}`];
        for (const detail of editDetails) {
          const file = relativeEditPath(target, extractEditFile(detail.input) ?? "edit");
          const diff = formatEditDiff(detail.input, settings.diffStyle, target.directory);
          const capped = capDiff(diff, 15);
          editLines.push(`✏️ <b>${esc(file)}</b>`);
          if (diff.trim()) {
            editLines.push(`<blockquote expandable><pre><code class="language-diff">${colorDiff(capped)}</code></pre></blockquote>`);
          }
        }
        lines.push(editLines.join("\n"));
      }
    }
    if (target.compacting) {
      lines.push("📦 <b>Compacting context…</b>");
    } else if (target.compactionError?.trim()) {
      lines.push(`📦 <b>Compaction failed</b>\n<i>${esc(target.compactionError.trim().slice(0, 240))}</i>`);
    } else if (target.compactionSummary?.trim()) {
      const sum = target.compactionSummary.trim();
      if (sum.length > 220) lines.push(`<blockquote expandable>📦 <b>Compaction</b>
${esc(sum.slice(0, 2000))}</blockquote>`);
      else lines.push(`📦 <b>Compaction</b>: ${esc(sum)}`);
    }
    if (settings.showFinalInCard && target.lastFinalText?.trim()) {
      lines.push(`<h4>${t("answer", settings.locale)}</h4>${markdownToHtml(target.lastFinalText.trim().slice(0, 2200))}`);
    }
    let resourceBlock = "";
    if (settings.showResourceUsage) {
      resourceBlock = renderResourceBlock(target, { history: settings.resourceHistory, theme: settings.cardTheme });
      lines.push(resourceBlock);
    }
    // Tool stats as a compact icon line at the very bottom (above the receipt).
    const toolStats = renderToolStats(target.toolCallDetails);
    if (toolStats) lines.push(`<p><i>${esc(toolStats)}</i></p>`);
    // Receipt as a quiet footer, after the answer and the indicators.
    lines.push(target.stopped ? "⏹ <b>Detenido</b>" : "✅ <b>Listo</b>");
    if (settings.showResourceUsage) {
      const full = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
      if (full.length > 3900 && resourceBlock) {
        const without = full.replace(resourceBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd();
        const headMax = 3900 - resourceBlock.length - 5;
        return without.slice(0, Math.max(0, headMax)) + "\n…\n" + resourceBlock;
      }
      return full;
    }
    return lines.join("\n");
  };

  const finishedKeyboard = (editDetails: ChatSession["toolCallDetails"], expandedEditIndex: number | undefined, target: ChatSession, messageId?: number): Array<Array<{ text: string; callback_data?: string; copy_text?: { text: string } }>> => {
    const keyboard: Array<Array<{ text: string; callback_data?: string; copy_text?: { text: string } }>> = [];
    editDetails.forEach((detail: ChatSession["toolCallDetails"][number], index: number) => {
      const file = relativeEditPath(target, extractEditFile(detail.input) ?? `edit ${index + 1}`);
      const label = expandedEditIndex === index ? `✏️ ${file} ▾` : `✏️ ${file}`;
      keyboard.push([{ text: label.slice(0, 64), callback_data: `edit:${index}` }]);
    });
    if (editDetails.length && messageId !== undefined) {
      keyboard.push([
        { text: "📄 Diffs completos", callback_data: `edits:full:${messageId}` },
        { text: "📦 Descargar .patch", callback_data: `patch:${messageId}` },
      ]);
      const plain = plainDiff(editDetails, "unified", target.directory);
      const native = copyTextButton(0, "📋 Copiar diff", plain);
      if (native) keyboard.push([native]);
    }
    keyboard.push([
      { text: "🧠 Modelo", callback_data: `panel:ms:${target.sessionId}` },
      { text: "📂 Sesiones", callback_data: "panel:sessions" },
    ]);
    return keyboard;
  };

  /** P1.4: a plain unified patch assembled from the turn's edit snapshots. */
  const plainDiff = (
    editDetails: ChatSession["toolCallDetails"],
    style: ChatSettings["diffStyle"],
    directory?: string,
  ): string => {
    const blocks = editDetails.map((detail) => {
      const file = relativeEditPath({ directory } as ChatSession, extractEditFile(detail.input) ?? "edit");
      return formatEditDiff(detail.input, style, directory).trim() || `--- ${file}\n+++ ${file}`;
    });
    return blocks.join("\n\n") + "\n";
  };

  /** Expanded-file toggle for edit messages, keyed by chatId:messageId. */
  const editToggles = new Map<string, number | undefined>();

  /**
   * Resolve the edit snapshot for a message: the live session when available,
   * otherwise the persisted snapshot (survives new turns and restarts).
   */
  const resolveEditsFor = (chatId: number, messageId: number): { s?: ChatSession; edits: Array<ChatSession["toolCallDetails"][number]>; directory?: string; header: string; threadId?: number; snapshotId?: string } | undefined => {
    const snap = store?.getPendingEditsSnapshot(chatId, messageId);
    if (!snap) return undefined;
    const key = pendingEditsKey(chatId, messageId);
    let s = pendingEdits.get(key) ?? store?.findSessionById(snap.sessionId);
    if (s) pendingEdits.set(key, s);
    const edits = (snap.edits?.length ? snap.edits : s?.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input)) ?? []) as Array<ChatSession["toolCallDetails"][number]>;
    if (!edits.length) return undefined;
    const header = s ? sessionHeader(s).trimEnd() : `📌 <code>${esc(snap.sessionId.slice(0, 12))}</code>\n`;
    return { s, edits, directory: s?.directory, header, threadId: s?.targetThreadId ?? s?.threadId, snapshotId: snap.sessionId };
  };

  const showEditDiff = async (chatId: number, messageId: number, index: number): Promise<boolean> => {
    const resolved = resolveEditsFor(chatId, messageId);
    if (!resolved || !resolved.edits[index]) return false;
    const toggleKey = `${chatId}:${messageId}`;
    const next = editToggles.get(toggleKey) === index ? undefined : index;
    editToggles.set(toggleKey, next);
    if (editToggles.size > 200) {
      const oldest = editToggles.keys().next().value;
      if (oldest !== undefined) editToggles.delete(oldest);
    }
    if (resolved.s) resolved.s.expandedEditIndex = next;
    const settings = getSettings(chatId);
    const lines: string[] = [resolved.header, `<h4>Cambios (${resolved.edits.length})</h4>`];
    resolved.edits.forEach((detail, i) => {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? `edit ${i + 1}`);
      const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
      const expanded = next === i;
      lines.push(`✏️ <b>${esc(file)}</b>${expanded ? " ▾" : ""}`);
      if (diff.trim()) {
        // The expanded file shows the full diff; the rest stay capped.
        lines.push(`<blockquote expandable><pre><code class="language-diff">${colorDiff(expanded ? diff : capDiff(diff, 12))}</code></pre></blockquote>`);
      }
    });
    const keyboard = finishedKeyboard(resolved.edits, next, (resolved.s ?? ({ sessionId: resolved.snapshotId ?? "unknown", directory: resolved.directory } as unknown as ChatSession)), messageId);
    const opts = resolved.s ? threadOptsFor(resolved.s) : threadOpts(resolved.threadId);
    await tg.editRichMessage(chatId, messageId, clampText(lines.join("\n"), 3900), {
      ...opts,
      reply_markup: { inline_keyboard: keyboard },
    }).catch((err) => console.warn("[status]", err?.message ?? err));
    return true;
  };

  const sendFullDiffs = async (chatId: number, messageId: number, threadId?: number): Promise<boolean> => {
    const resolved = resolveEditsFor(chatId, messageId);
    if (!resolved) return false;
    const settings = getSettings(chatId);
    // P1.4: PR-style review — one summary table with +/− counts, then the
    // per-file diffs and their actions.
    const rows = resolved.edits.map((detail) => {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? "edit");
      const { added, removed } = editStats(detail.input);
      return `<tr><td><code>${esc(file)}</code></td><td>+${added}</td><td>−${removed}</td></tr>`;
    });
    const table = `<table><tr><th>Archivo</th><th>+</th><th>−</th></tr>${rows.join("")}</table>`;
    const parts: string[] = [];
    for (const detail of resolved.edits) {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? "edit");
      const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
      parts.push(`✏️ <b>${esc(file)}</b>\n<blockquote expandable><pre><code class="language-diff">${colorDiff(diff)}</code></pre></blockquote>`);
    }
    const full = `${resolved.header}\n<b>Revisión de cambios</b> (${resolved.edits.length})\n${table}\n\n${parts.join("\n\n")}`;
    const fallback = resolved.s ?? ({ sessionId: resolved.snapshotId ?? "unknown", directory: resolved.directory } as unknown as ChatSession);
    const reviewKeyboard = finishedKeyboard(resolved.edits, undefined, fallback, messageId);
    reviewKeyboard.push([{ text: "📦 Descargar .patch", callback_data: `patch:${messageId}` }]);
    const plain = plainDiff(resolved.edits, "unified", resolved.directory);
    const nativeCopy = copyTextButton(0, "📋 Copiar diff", plain);
    if (nativeCopy) reviewKeyboard.push([nativeCopy]);
    else reviewKeyboard.push([{ text: "📋 Copiar diff", callback_data: `copy:diff:${fallback.sessionId}:${messageId}` }]);
    const opts = { ...threadOpts(threadId ?? resolved.threadId), reply_markup: { inline_keyboard: reviewKeyboard } };
    if (full.length <= 3800) {
      await tg.sendRichMessage(chatId, full, opts).catch((err) => console.warn("[status]", err?.message ?? err));
    } else {
      let remaining = full;
      let first = true;
      while (remaining.length > 3800) {
        let cut = remaining.lastIndexOf("\n", 3800);
        if (cut < 1900) cut = 3800;
        await tg.sendRichMessage(chatId, remaining.slice(0, cut), first ? opts : threadOpts(threadId ?? resolved.threadId)).catch((err) => console.warn("[status]", err?.message ?? err));
        first = false;
        remaining = remaining.slice(cut).trimStart();
      }
      if (remaining) await tg.sendRichMessage(chatId, remaining, first ? opts : threadOpts(threadId ?? resolved.threadId)).catch((err) => console.warn("[status]", err?.message ?? err));
    }
    return true;
  };

  /** P1.4: resolve a persisted edit snapshot into a plain patch (for copy). */
  const plainDiffFor = (chatId: number, messageId: number): string | undefined => {
    const resolved = resolveEditsFor(chatId, messageId);
    if (!resolved) return undefined;
    return plainDiff(resolved.edits, "unified", resolved.directory);
  };

  /** P1.4: send the turn's edits as a ready-to-apply .patch document. */
  const sendPatch = async (chatId: number, messageId: number, threadId?: number): Promise<boolean> => {
    const resolved = resolveEditsFor(chatId, messageId);
    if (!resolved) return false;
    const body = plainDiff(resolved.edits, "unified", resolved.directory);
    try {
      const dir = join(tmpdir(), "opencode", "exports");
      mkdirSync(dir, { recursive: true });
      const name = `${sessionHeader(resolved.s).replace(/<[^>]+>/g, "").trim().replace(/[^\w-]+/g, "-").slice(0, 40) || "session"}-${messageId}.patch`;
      const path = join(dir, name.replace(/[^\w.-]/g, "_"));
      writeFileSync(path, body, "utf8");
      await tg.sendDocument(chatId, path, name, `📦 <b>Patch</b> · ${resolved.edits.length} archivo(s)\n<i>Aplica con: git apply archivo.patch</i>`, {
        ...threadOpts(threadId ?? resolved.threadId),
        parse_mode: "HTML",
      });
      return true;
    } catch (err) {
      console.warn("[status] patch failed", err);
      return false;
    }
  };

  /**
   * Open a file's diff in a reusable drill-down message, leaving the session
   * card untouched (the card is the single source of truth for the turn).
   */
  const showEditDetail = async (chatId: number, messageId: number, index: number): Promise<boolean> => {
    const resolved = resolveEditsFor(chatId, messageId);
    const detail = resolved?.edits[index];
    if (!resolved || !detail) return false;
    const settings = getSettings(chatId);
    const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? `edit ${index + 1}`);
    const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
    const { added, removed } = editStats(detail.input);
    const text = `${resolved.header}<h4>✏️ ${esc(file)} <i>+${added}/-${removed}</i></h4>\n<blockquote expandable><pre><code class="language-diff">${colorDiff(diff)}</code></pre></blockquote>`;
    const target = resolved.s ?? ({ sessionId: resolved.snapshotId ?? "unknown", directory: resolved.directory } as unknown as ChatSession);
    const keyboard = finishedKeyboard(resolved.edits, index, target, resolved.s?.detailMessageId ?? messageId);
    const opts = resolved.s ? threadOptsFor(resolved.s) : threadOpts(resolved.threadId);
    const html = clampText(text, 3900);
    const markup = { reply_markup: { inline_keyboard: keyboard } };
    if (resolved.s?.detailMessageId) {
      await tg.editRichMessage(chatId, resolved.s.detailMessageId, html, { ...opts, ...markup }).catch((err) => console.warn("[status]", err?.message ?? err));
    } else {
      const sent = await tg.sendRichMessage(chatId, html, { ...opts, ...markup }).catch(() => undefined);
      if (sent?.message_id && resolved.s) {
        resolved.s.detailMessageId = sent.message_id;
        store?.rememberMessageSession(chatId, sent.message_id, resolved.s.sessionId);
        store?.rememberPendingEdits(chatId, sent.message_id, resolved.s.sessionId, resolved.edits);
      }
    }
    return true;
  };

  return { startStatus, updateStatus, finishStatus, publishCard, showEditDiff, showEditDetail, sendFullDiffs, sendPatch, plainDiffFor };
}
