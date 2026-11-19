import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession, CardView } from "./types.js";
import type { SessionStore } from "./store.js";
import { pendingEditsKey } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import { isEditTool, extractEditFile, formatEditDiff, editStats } from "./editutil.js";
import { clampText, colorDiff, copyTextButton, esc, markdownToHtml, sessionHeader, stripRestatedPrompt, threadOpts, toolIcon, truncate } from "./util.js";
import { throttleGap } from "./ratethrottle.js";
import { STATUS_BACKGROUND_GAP_MS, STATUS_MIN_UPDATE_GAP_MS } from "./constants.js";
import type { DashboardManager } from "./dashboard.js";
import type { TranscriptManager } from "./transcriptmanager.js";
import { renderResourceBlock } from "./resources.js";
import { closeOpen, createTurnActivity, renderActivity } from "./activity.js";
import { renderTodos } from "./todos.js";
import { capDiff, detectTestRun, getToolSummary, isShellTool, parseShellCommand, parseToolInput, relativeEditPath, renderShell, renderTools, renderTurnReceipt, shortToolArg, summarizeEdits, turnTelemetry, StatusDeps, truncateText } from "./status-render.js";

export type StatusManager = ReturnType<typeof createStatusManager>;

export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits, rememberCot, rememberStatusMessage, forgetStatusMessage, store, transcript, dashboard, mcpEvents }: StatusDeps) {
  const renderThinkingBottom = (s: ChatSession, settings: ChatSettings): string => {
    if (!settings.showThinking || !settings.showLatestThought || !s.reasoningBuffer.trim() || s.stopped) return "";
    const tail = s.reasoningBuffer.trim().slice(-1600);
    return `💭 <b>Pensando…</b>\n<blockquote expandable><mark>${markdownToHtml(tail)}</mark></blockquote>`;
  };

  const renderLatestToolBottom = (s: ChatSession, settings: ChatSettings): string => {
    if (!settings.showTools || !settings.showLatestTool || !s.toolCallDetails.length) return "";
    const lastTool = s.toolCallDetails[s.toolCallDetails.length - 1];
    const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
    const shell = isShellTool(lastTool.name);
    const summary = getToolSummary(lastTool.name, lastTool.input);
    let displayName = shell ? "Shell" : (lastTool.name || "Herramienta");
    if (shell || /^bash$/i.test(lastTool.name)) displayName = "Shell";

    let commandText = "";
    if (shell) {
      commandText = parseShellCommand(lastTool.input ?? "") ?? (lastTool.input ?? "").trim() ?? lastTool.name;
    } else {
      commandText = (summary?.arg ?? (lastTool.input ?? "").trim() ?? lastTool.name).toString();
    }
    commandText = commandText.trim();
    if (commandText.length > 1200) commandText = `${commandText.slice(0, 1200)}\n…`;

    const header = `${statusEmoji} <b>Última herramienta:</b> ${esc(displayName)}`;
    if (!commandText) return header;
    return `${header}\n<pre><code>${esc(commandText)}</code></pre>`;
  };

  /**
   * Live strip for the session card. Latest tool and thought are shown at the
   * bottom of the message (above resource indicators) for readability.
   */
  const renderLiveParts = (s: ChatSession, settings: ChatSettings, unified: boolean): { top: string; bottom: string } => {
    const lines: string[] = [];
    // 1. State first — "still working" is the most important signal at a glance.
    lines.push(
      s.stopped
        ? "<h4>⏹ Detenido</h4>"
        : "<h4>⏳ Trabajando…</h4>",
    );
    // 2. Telemetry (duration, speed, tokens, context) under the state. The card
    // stays readable while working; the finished turns get the full receipt.
    const telemetry = turnTelemetry(s, Date.now(), settings.showTokenSpeed);
    const tools = s.toolCallDetails.length;
    const failedTools = s.toolCallDetails.filter((detail) => detail.status === "failed").length;
    // The activity summary already carries tool counts; avoid showing them twice.
    if (tools && !s.activity) telemetry.push(`🔧 ${tools}${failedTools ? ` (${failedTools} ✗)` : ""}`);
    if (telemetry.length) lines.push(`<p><i>${esc(telemetry.join(" · "))}</i></p>`);
    // 3. Prompt being answered — context before detail.
    const prompt = store?.lastPromptBySession.get(s.sessionId);
    if (prompt?.trim()) {
      lines.push(`<p><i>📝 ${esc(truncate(prompt.trim(), 80))}</i></p>`);
    }
    // 4. Compact activity summary (OpenCode 2.3.0 style). One line of counters
    // plus a single expandable block replaces the separate thought/tool blocks.
    const activityBlock = renderActivity(s.activity, settings.cardVerbosity, false, Date.now(), s.activityExpanded === true);
    if (activityBlock) {
      lines.push(activityBlock);
    } else {
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
      lines.push("<p><i>🔀 En segundo plano: otra sesión ocupa la pestaña, esta sigue actualizando.</i></p>");
    }
    // 4. TODO checklist for the session (from todo.updated events).
    const todosBlock = renderTodos(store?.getTodos?.(s.sessionId) ?? []);
    if (todosBlock) lines.push(todosBlock);
    // 7. Partial answer in a blockquote, clearly distinct from reasoning.
    if (settings.showPartialText && s.buffer.trim()) {
      const cap = settings.cardVerbosity === "low" ? 200 : settings.cardVerbosity === "high" ? 800 : (unified ? 600 : 400);
      const tail = s.buffer.trim().slice(-cap);
      lines.push(`<p><i>💬 escribiendo…</i></p>\n<blockquote>${esc(tail)}</blockquote>`);
    }
    // 8. COT last, collapsed.
    if (!unified && settings.showCot && s.cotBuffer?.trim()) {
      lines.push(`<blockquote expandable>🧾 COT (${s.cotCount ?? 0})
${esc(s.cotBuffer.trim().slice(-800))}</blockquote>`);
    }
    return {
      top: lines.join(""),
      // Indicators (resources) and buttons are appended by publishCard below
      // extraBottom, so they stay at the very bottom of the card.
      bottom: "",
    };
  };


  /** Summary shown once the turn is over. */
  const renderDoneStrip = (s: ChatSession, settings: ChatSettings): string => {
    const prompt = store?.lastPromptBySession.get(s.sessionId);
    const edits = summarizeEdits(s, s.toolCallDetails);
    const test = detectTestRun(s.toolCallDetails);
    const lines: string[] = [renderTurnReceipt({
      stopped: s.stopped,
      error: s.lastTurnError,
      prompt,
      edits: edits.files ? edits : undefined,
      test,
      telemetry: turnTelemetry(s, Date.now(), settings.showTokenSpeed),
    })];
    const todosBlock = renderTodos(store?.getTodos?.(s.sessionId) ?? []);
    if (todosBlock) lines.push(todosBlock);
    if (s.detached) lines.push("<p><i>🔀 Esta sesión quedó en segundo plano.</i></p>");
    const doneActivity = renderActivity(s.activity, settings.cardVerbosity, true, Date.now(), s.activityExpanded === true);
    if (doneActivity) lines.push(doneActivity);
    if (settings.showFinalInCard && s.lastFinalText?.trim()) {
      // The answer is the whole point of the turn: show it above the fold.
      // Long answers stay reachable via 📄 Respuesta / 📖 Leer.
      lines.push(`<h4>💬 Respuesta</h4>\n${markdownToHtml(s.lastFinalText.trim().slice(0, 1600))}`);
    }
    if (settings.showTools && !s.activity && s.toolCallDetails.length) {
      const shell = s.toolCallDetails.filter((d) => isShellTool(d.name)).length;
      const other = s.toolCallDetails.length - shell;
      const parts: string[] = [];
      if (shell) parts.push(`${shell} shell`);
      if (other) parts.push(`${other} herramientas`);
      lines.push(`<p><i>🔧 ${parts.join(" · ")}</i></p>`);
    }
    return lines.join("");
  };

  /**
   * Publish the session card (M2). In unified mode the card carries the live
   * content without resource indicators (those live in M1) and streams the
   * latest thought at the bottom for readability.
   */
  const publishCard = async (chatId: number, s: ChatSession): Promise<void> => {
    // Cards are published for every chat now (linear mode disabled): one
    // paginated message per session, edited in place, with header/buttons/resources.
    if (!transcript) return;
    const settings = getSettings(chatId);
    const unified = settings.displayMode === "unified";
    const reading = s.readingMode === true;
    const compact = settings.compactCard && !s.cardMenuExpanded && !reading;
    s.cardView = { compact, reading, showResources: !unified, unified } satisfies CardView;
    // P1.1: the compact card keeps the receipt readable but never blows past
    // the 1.200-character budget; detail lives in ▾ Más / ▾ Detalles.
    // With the answer already in the strip, skip the duplicate answer block
    // in the transcript page (the full answer stays reachable via 📖 Leer).
    const hideAnswer = settings.showFinalInCard && !!s.lastFinalText?.trim() && !reading;
    const cap = (html: string) => compact && !hideAnswer ? clampText(html, 650) : html;
    if (reading) {
      await transcript.publish(chatId, s, { ...s.cardView, extraTop: "", working: false });
    } else if (s.statusFinished) {
      await transcript.publish(chatId, s, {
        ...s.cardView,
        extraTop: cap(renderDoneStrip(s, settings)),
        working: false,
        hideAnswer,
      });
    } else {
      const parts = renderLiveParts(s, settings, unified);
      await transcript.publish(chatId, s, {
        ...s.cardView,
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
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    if (s.deltaFlushTimer) { clearTimeout(s.deltaFlushTimer); s.deltaFlushTimer = undefined; }
    s.buffer = "";
    s.reasoningBuffer = "";
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.activity = createTurnActivity();
    s.activityExpanded = false;
    s.readingMode = false;
    s.cardMenuExpanded = false;
    s.lastViewedTurn = undefined;
    // A detail drill-down belongs to one turn's edit snapshot. Keeping the old
    // message id makes later turns edit that stale message with new diffs.
    s.detailMessageId = undefined;
    if (s.resourcesCollapsed === undefined) s.resourcesCollapsed = true;
    s.turnOutputTokens = 0;
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
    // Keep the previous final-answer message id for rapid-final editing; do
    // not delete it here (deleting on new turn surprised users and removed
    // content they wanted to keep). The new turn's card starts fresh via
    // refloat + pageBreak, so the old tail does not linger in the live view.
    try {
      if (unified && dashboard) {
        await dashboard.ensure(chatId, s.targetThreadId ?? s.threadId, s, { working: true }).catch((err) => console.warn("[status] dashboard.ensure failed", err?.message ?? err));
      }
      if (transcript) {
        // Every turn gets its own card created immediately at the bottom, with
        // live streaming while working. Unified and "única" (refloat) replace
        // the previous card (single message per session); "conservar" keeps the
        // finished card as history; "fija" keeps editing the same card in place.
        store?.beginTurn?.(s);
        s.transcriptFollow = true;
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
      if (settings.showResourceUsage) lines.push("<hr/>", renderResourceBlock(s));
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

      const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
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
        latestThoughtBlock = `💭 <b>Último pensamiento:</b>\n<blockquote><mark>${esc(clampText(lastThought, 240))}</mark></blockquote>`;
      }

      let shellBlock = "";
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails.slice(-5), 180);
        shellBlock = `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`;
      }

      let toolsBlock = "";
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails.slice(-6), 180, settings.showToolInput);
        toolsBlock = `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Herramientas (${otherDetails.length})\n${details}</blockquote>`;
      } else if (settings.showTools && !shellDetails.length && !editDetails.length && s.toolCalls.length) {
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
          `<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Razonamiento
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
      if (settings.showTools && s.toolCallDetails.length) {
        const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
        const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
        if (shellDetails.length) {
          const shellText = renderShell(shellDetails, 800);
          transcript.addBlock(
            s,
            "tools",
            `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`,
            shellText,
            (chunk) => `<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell
<pre language=\'bash\'>${esc(chunk)}</pre></blockquote>`,
            shellDetails.map((d) => ({ name: d.name, input: d.input, output: d.output, status: d.status })),
          );
        }
        if (otherDetails.length) {
          const details = renderTools(otherDetails, 1200, settings.showToolInput);
          transcript.addBlock(
            s,
            "tools",
            `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Herramientas (${otherDetails.length})\n${details}</blockquote>`,
            details,
            (chunk) => `<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Herramientas
${chunk}</blockquote>`,
            otherDetails.map((d) => ({ name: d.name, input: d.input, output: d.output, status: d.status })),
          );
        }
      }
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
    lines.push(target.stopped ? "⏹ <b>Detenido</b>" : "✅ <b>Listo</b>");
    if (!settings.compactFinal) {
      if (inlineThinking && settings.showThinking && !target.stopped && target.reasoningBuffer.trim()) {
        const r = target.reasoningBuffer.trim();
        lines.push(`<blockquote${settings.thinkingExpanded ? "" : " expandable"}>🧠 Razonamiento
${esc(r)}</blockquote>`);
      }
      const shellDetails = target.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = target.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
      const editDetails = target.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails, 500);
        lines.push(`<blockquote${settings.shellExpanded ? "" : " expandable"}>🖥 Shell (${shellDetails.length})\n<pre language='bash'>${esc(shellText)}</pre></blockquote>`);
      }
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails, 500);
        lines.push(`<blockquote${settings.toolsExpanded ? "" : " expandable"}>🔧 Herramientas (${otherDetails.length})\n${details}</blockquote>`);
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
    let resourceBlock = "";
    if (settings.showResourceUsage) {
      target.cardTheme = settings.cardTheme;
      resourceBlock = renderResourceBlock(target, { history: settings.resourceHistory });
      lines.push(resourceBlock);
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
    const keyboard = finishedKeyboard(resolved.edits, undefined, resolved.s as ChatSession, messageId);
    const parts: string[] = [];
    for (const detail of resolved.edits) {
      const file = relativeEditPath(resolved.s as ChatSession, extractEditFile(detail.input) ?? "edit");
      const diff = formatEditDiff(detail.input, settings.diffStyle, resolved.directory);
      parts.push(`✏️ <b>${esc(file)}</b>\n<blockquote><pre><code class="language-diff">${colorDiff(diff)}</code></pre></blockquote>`);
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
    const settings = getSettings(chatId);
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
    const text = `${resolved.header}<h4>✏️ ${esc(file)} <i>+${added}/-${removed}</i></h4>\n<blockquote><pre><code class="language-diff">${colorDiff(diff)}</code></pre></blockquote>`;
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
