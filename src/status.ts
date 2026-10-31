import type { ChatSession } from "./types.js";
import type { TelegramClient } from "./telegram.js";
import type { ChatSettings } from "./settings.js";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEditTool, extractEditFile, formatEditDiff } from "./editutil.js";
import { formatBytes } from "./files.js";
import { clampText, esc } from "./util.js";

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function parseShellCommand(input: string): string | null {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed.command === "string") return parsed.command;
  } catch {
    // Not JSON or not a shell command.
  }
  return null;
}

function parseShellOutput(output: string): string | null {
  const trimmed = output.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((item: { text?: unknown; content?: unknown }) => {
          if (typeof item?.text === "string") return item.text;
          if (typeof item?.content === "string") return item.content;
          return "";
        })
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (parsed && typeof parsed.text === "string") return parsed.text;
    if (parsed && typeof parsed.content === "string") return parsed.content;
  } catch {
    // Fall back to extracting text fields from truncated JSON.
  }
  const matches = [...trimmed.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
  if (matches.length) {
    return matches
      .map((match) => {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return match[1];
        }
      })
      .join("\n");
  }
  return null;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export type StatusDeps = {
  tg: TelegramClient;
  threadOptsFor: (s: ChatSession | undefined) => Record<string, unknown>;
  getSettings: (chatId: number) => ChatSettings;
  pendingEdits: Map<number, ChatSession>;
  rememberCot: (sessionId: string, buffer: string, count: number) => void;
};

export type StatusManager = ReturnType<typeof createStatusManager>;

function renderTools(details: ChatSession["toolCallDetails"], limit: number): string {
  return details
    .map((d) => {
      const status = d.status === "success" ? "✅" : d.status === "failed" ? "❌" : "⏳";
      const lines = [status + " " + d.name];
      if (d.input) {
        const command = parseShellCommand(d.input);
        lines.push(command ? "$ " + command : prettyJson(d.input));
      }
      if (d.output) {
        const output = parseShellOutput(d.output) ?? d.output;
        lines.push(truncateText(output, limit));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function isShellTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "sh" || normalized.includes("shell");
}

function renderShell(details: ChatSession["toolCallDetails"], limit: number): string {
  return details
    .map((d) => {
      const command = parseShellCommand(d.input ?? "") ?? d.input?.trim() ?? d.name;
      const output = (parseShellOutput(d.output ?? "") ?? d.output ?? "").trim();
      const lines = ["$ " + command];
      if (output) lines.push(truncateText(output, limit));
      if (d.status === "failed") lines.push("(failed)");
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Owns the lifecycle of the single "status" card that accompanies a turn:
 * Working… (thinking, tools, partial text) → Done / Stopped, no Stop button.
 */
function readMemoryPercent(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1]);
    const available = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0) {
      return Math.max(0, Math.min(100, Math.round((1 - available / total) * 100)));
    }
  } catch {
    // Fall back to os.freemem() on non-Linux or permission errors.
  }
  return Math.max(0, Math.min(100, Math.round((1 - os.freemem() / os.totalmem()) * 100)));
}

function readGpuPercent(): number | null {
  const info = readGpuInfo();
  return info ? info.load : null;
}

function progressBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

type GpuInfo = { name: string; usedMB: number; totalMB: number; load: number; temperature: number | null };

function readGpuInfo(): GpuInfo | null {
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 1500, encoding: "utf8" },
    )
      .trim()
      .split("\n")[0];
    const parts = out.split(",").map((part) => part.trim());
    if (parts.length < 4) return null;
    const name = parts[0] || "GPU";
    const usedMB = Number(parts[1]);
    const totalMB = Number(parts[2]);
    const load = Number(parts[3]);
    const temperature = parts[4] ? Number(parts[4]) : null;
    if (!Number.isFinite(usedMB) || !Number.isFinite(totalMB) || totalMB <= 0 || !Number.isFinite(load)) return null;
    return { name, usedMB, totalMB, load: Math.max(0, Math.min(100, load)), temperature: Number.isFinite(temperature as number) ? temperature : null };
  } catch {
    // No GPU or nvidia-smi unavailable.
  }
  return null;
}

export function createStatusManager({ tg, threadOptsFor, getSettings, pendingEdits, rememberCot }: StatusDeps) {
  const flushDraft = async (chatId: number, s: ChatSession | undefined) => {
    if (!s) return;
    s.timer = undefined;
    // Drafts are only available in private chats.
    if (chatId < 0) return;
    try {
      await tg.sendRichMessageDraftMarkdown(chatId, s.draftId, s.buffer || "…", { can_stop: true, ...threadOptsFor(s) });
    } catch (err) {
      console.error("[draft]", err);
    }
  };

  const startStatus = async (chatId: number, s: ChatSession) => {
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    s.statusFinished = false;
    s.statusEditPromise = undefined;
    s.statusEditing = false;
    s.buffer = "";
    s.reasoningBuffer = "";
    s.toolCalls = [];
    s.toolCallDetails = [];
    s.stopped = false;
    try {
      const lines: string[] = [];
      if (settings.showThinking && s.cotBuffer?.trim()) {
        const cot = s.cotBuffer.trim().slice(-1500);
        lines.push(`<details><summary>🧾 COT (${s.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
      }
      lines.push("⏳ <b>Working…</b>\n<i>Waiting for OpenCode</i>");
      const sent = await tg.sendRichMessage(chatId, clampText(lines.join("\n")), {
        ...opts,
        reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "panel:stop" }]] },
      });
      s.statusMessageId = sent.message_id;
      s.statusLastUpdate = Date.now();
    } catch (err) {
      console.error("[status]", err);
    }
  };

  const updateStatus = async (chatId: number, s: ChatSession, force = false) => {
    if (!s.statusMessageId || s.statusFinished) return;
    if (s.statusEditing) return;
    const opts = threadOptsFor(s);
    const settings = getSettings(chatId);
    const now = Date.now();
    if (!force && s.statusLastUpdate && now - s.statusLastUpdate < 4000) return;
    s.statusEditing = true;
    s.statusLastUpdate = now;
    const lines: string[] = [];
    if (settings.showThinking && s.cotBuffer?.trim()) {
      const cot = s.cotBuffer.trim().slice(-1500);
      lines.push(`<details><summary>🧾 COT (${s.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
    }
    const elapsed = s.promptStartTime ? Math.max(1, Math.round((Date.now() - s.promptStartTime) / 1000)) : 0;
    lines.push("⏳ <b>Working…</b>" + (elapsed ? ` <i>(${elapsed}s)</i>` : ""));
    if (settings.showThinking && s.reasoningBuffer.trim()) {
      const r = s.reasoningBuffer.trim().slice(-800);
      lines.push(`<details${settings.thinkingExpanded ? " open" : ""}><summary>🧠 Thinking</summary>\n<pre>` + esc(r) + "</pre>\n</details>");
    }
    const shellDetails = s.toolCallDetails.filter((detail) => isShellTool(detail.name));
    const otherDetails = s.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
    if (settings.showTools && settings.showShell && shellDetails.length) {
      const shellText = renderShell(shellDetails.slice(-5), 200);
      lines.push(`<details${settings.shellExpanded ? " open" : ""}><summary>🖥 Shell (` + shellDetails.length + ")</summary>\n<pre>" + esc(shellText) + "</pre>\n</details>");
    }
    if (settings.showTools && otherDetails.length) {
      const details = renderTools(otherDetails.slice(-5), 200);
      lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🔧 Tool calls (` + otherDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
    } else if (settings.showTools && !shellDetails.length && !editDetails.length && s.toolCalls.length) {
      lines.push("🔧 " + esc(s.toolCalls.slice(-5).join(", ")));
    }
    if (settings.showTools && editDetails.length) {
      const names = editDetails.map((detail) => extractEditFile(detail.input) ?? "edit").map((file) => file.split("/").pop() ?? file).join(", ");
      lines.push(`✏️ Edits (${editDetails.length}): ${esc(names)}`);
    }
    if (settings.showPartialText && s.buffer.trim()) {
      lines.push("<pre>" + esc(s.buffer.trim().slice(0, 300)) + "</pre>");
    }
    // Highlight the latest thought and the latest tool call, right above
    // the resource indicators, so the user always sees what the agent is
    // doing now without scrolling.
    if (settings.showThinking && s.reasoningBuffer.trim()) {
      const reasoningLines = s.reasoningBuffer.trim().split(/\n+/).filter(Boolean);
      const lastThought = reasoningLines.length ? reasoningLines[reasoningLines.length - 1] : s.reasoningBuffer.trim();
      lines.push(`💭 <b>Latest thought:</b> <i>${esc(clampText(lastThought, 240))}</i>`);
    }
    const lastTool = s.toolCallDetails.length ? s.toolCallDetails[s.toolCallDetails.length - 1] : null;
    if (lastTool) {
      const toolName = lastTool.name;
      const toolInput = lastTool.input ? clampText(lastTool.input, 120) : "";
      const statusEmoji = lastTool.status === "success" ? "✅" : lastTool.status === "failed" ? "❌" : "⏳";
      lines.push(`${statusEmoji} <b>Latest tool:</b> <code>${esc(toolName)}</code>${toolInput ? " — " + esc(toolInput) : ""}`);
    }
    if (settings.showResourceUsage) {
      if (!s.cpuHistory) s.cpuHistory = [];
      if (!s.memHistory) s.memHistory = [];
      const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
      const memPercent = readMemoryPercent();
      s.cpuHistory.push(cpuPercent);
      s.memHistory.push(memPercent);
      const limit = settings.resourceHistory;
      while (s.cpuHistory.length > limit) s.cpuHistory.shift();
      while (s.memHistory.length > limit) s.memHistory.shift();
      const cpuBar = progressBar(cpuPercent);
      const memBar = progressBar(memPercent);
      lines.push(`📊 CPU ${cpuBar} ${cpuPercent}% · RAM ${memBar} ${memPercent}%`);
      const gpu = readGpuInfo();
      if (gpu) {
        const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
        const vramBar = progressBar(vramPercent);
        const temp = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
        lines.push(`🎮 ${esc(gpu.name)} · VRAM ${vramBar} ${formatBytes(gpu.usedMB * 1024 * 1024)}/${formatBytes(gpu.totalMB * 1024 * 1024)} (${vramPercent}%) · load ${progressBar(gpu.load)} ${gpu.load}%${temp}`);
      }
    }
    if (s.compacting) {
      lines.push("📦 <b>Compacting context…</b>");
    } else if (s.compactionSummary?.trim()) {
      lines.push("📦 " + esc(s.compactionSummary.trim().slice(0, 200)));
    }
    try {
      const edit = tg.editRichMessage(chatId, s.statusMessageId, clampText(lines.join("\n")), {
        ...opts,
        reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "panel:stop" }]] },
      });
      s.statusEditPromise = edit.then(
        () => undefined,
        () => undefined,
      );
      await edit;
    } catch (err) {
      console.error("[status]", err);
    } finally {
      s.statusEditing = false;
      s.statusEditPromise = undefined;
    }
  };

  /** Freeze the status card. Stop disappears; thinking/tools stay collapsible. */
  const finishStatus = async (chatId: number, s: ChatSession) => {
    console.log("[finishStatus] called", chatId, "statusMsg=", s.statusMessageId, "edits=", s.toolCallDetails.filter((d) => isEditTool(d.name, d.input)).length);
    if (s.statusTimer) {
      clearInterval(s.statusTimer);
      s.statusTimer = undefined;
    }
    s.statusFinished = true;
    if (s.statusEditPromise) {
      await s.statusEditPromise.catch(() => {});
      s.statusEditPromise = undefined;
    }
    if (s.statusMessageId) {
      const settings = getSettings(chatId);
      const messageId = s.statusMessageId;
      s.expandedEditIndex = undefined;
      const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (editDetails.length) pendingEdits.set(messageId, s);
      const text = clampText(renderFinished(s, undefined, settings));
      await tg
        .editRichMessage(chatId, messageId, text, {
          ...threadOptsFor(s),
          reply_markup: { inline_keyboard: [] },
        })
        .catch((err) => console.error("[status] finish edit FAILED", messageId, err));
      if (!s.stopped && s.reasoningBuffer.trim()) {
        const chunk = s.reasoningBuffer.trim();
        const prev = s.cotBuffer?.trim() ? s.cotBuffer.trim() + "\n\n---\n\n" : "";
        let next = prev + chunk;
        if (next.length > 4000) next = next.slice(next.length - 4000);
        s.cotBuffer = next;
        s.cotCount = (s.cotCount ?? 0) + 1;
        s.reasoningBuffer = "";
        rememberCot(s.sessionId, next, s.cotCount);
      }
      s.statusMessageId = undefined;
    }
  };

  const renderFinished = (target: ChatSession, expandedEditIndex: number | undefined, settings: ChatSettings): string => {
    const previousCot = target.cotBuffer?.trim() ?? "";
    const lines: string[] = [];
    if (settings.showThinking && previousCot) {
      const cot = previousCot.slice(-3500);
      lines.push(`<details><summary>🧾 COT (${target.cotCount ?? 0})</summary>\n<pre>${esc(cot)}</pre>\n</details>`);
    }
    lines.push("✅ <b>Done</b>");
    if (!settings.compactFinal) {
      if (settings.showThinking && !target.stopped && target.reasoningBuffer.trim()) {
        const r = target.reasoningBuffer.trim().slice(0, 3500);
        lines.push(`<details${settings.thinkingExpanded ? " open" : ""}><summary>🧠 Thinking</summary>\n<pre>` + esc(r) + "</pre>\n</details>");
      }
      const shellDetails = target.toolCallDetails.filter((detail) => isShellTool(detail.name));
      const otherDetails = target.toolCallDetails.filter((detail) => !isShellTool(detail.name) && !isEditTool(detail.name, detail.input));
      const editDetails = target.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
      if (settings.showTools && settings.showShell && shellDetails.length) {
        const shellText = renderShell(shellDetails, 500);
        lines.push(`<details${settings.shellExpanded ? " open" : ""}><summary>🖥 Shell (` + shellDetails.length + ")</summary>\n<pre>" + esc(shellText) + "</pre>\n</details>");
      }
      if (settings.showTools && otherDetails.length) {
        const details = renderTools(otherDetails, 500);
        lines.push(`<details${settings.toolsExpanded ? " open" : ""}><summary>🔧 Tool calls (` + otherDetails.length + ")</summary>\n<pre><code>" + esc(details) + "</code></pre>\n</details>");
      }
      if (settings.showTools && editDetails.length) {
        const editLines = [`✏️ Edits: ${editDetails.length}`];
        for (const detail of editDetails) {
          const file = relativeEditPath(target, extractEditFile(detail.input));
          const diff = formatEditDiff(detail.input, settings.diffStyle, target.directory);
          editLines.push(`<details><summary>✏️ ${esc(file)}</summary>\n<pre><code class="language-diff">${esc(diff)}</code></pre>\n</details>`);
        }
        lines.push(editLines.join("\n"));
      }
    }
    if (target.compacting) {
      lines.push("📦 <b>Compacting context…</b>");
    } else if (target.compactionSummary?.trim()) {
      lines.push("📦 " + esc(target.compactionSummary.trim().slice(0, 300)));
    }
    if (settings.showResourceUsage) {
      if (!target.cpuHistory) target.cpuHistory = [];
      if (!target.memHistory) target.memHistory = [];
      const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
      const memPercent = readMemoryPercent();
      target.cpuHistory.push(cpuPercent);
      target.memHistory.push(memPercent);
      const limit = settings.resourceHistory;
      while (target.cpuHistory.length > limit) target.cpuHistory.shift();
      while (target.memHistory.length > limit) target.memHistory.shift();
      const cpuBar = progressBar(cpuPercent);
      const memBar = progressBar(memPercent);
      lines.push(`📊 CPU ${cpuBar} ${cpuPercent}% · RAM ${memBar} ${memPercent}%`);
      const gpu = readGpuInfo();
      if (gpu) {
        const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
        const vramBar = progressBar(vramPercent);
        const temp = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
        lines.push(`🎮 ${esc(gpu.name)} · VRAM ${vramBar} ${formatBytes(gpu.usedMB * 1024 * 1024)}/${formatBytes(gpu.totalMB * 1024 * 1024)} (${vramPercent}%) · load ${progressBar(gpu.load)} ${gpu.load}%${temp}`);
      }
    }
    return lines.join("\n");
  };

  const finishedKeyboard = (editDetails: ChatSession["toolCallDetails"], expandedEditIndex: number | undefined, target: ChatSession): Array<Array<{ text: string; callback_data: string }>> => {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    editDetails.forEach((detail, index) => {
      const file = relativeEditPath(target, extractEditFile(detail.input) ?? `edit ${index + 1}`);
      const label = expandedEditIndex === index ? `✏️ ${file} ▾` : `✏️ ${file}`;
      keyboard.push([{ text: label.slice(0, 64), callback_data: `edit:${index}` }]);
    });
    return keyboard;
  };

  const relativeEditPath = (target: ChatSession, file: string | null): string => {
    if (!file) return "edit";
    if (!target.directory) return file.split("/").pop() ?? file;
    const prefix = target.directory.endsWith("/") ? target.directory : target.directory + "/";
    if (file.startsWith(prefix)) return file.slice(prefix.length);
    return file.split("/").pop() ?? file;
  };

  const showEditDiff = async (chatId: number, messageId: number, index: number): Promise<boolean> => {
    const s = pendingEdits.get(messageId);
    if (!s) return false;
    const editDetails = s.toolCallDetails.filter((detail) => isEditTool(detail.name, detail.input));
    if (!editDetails[index]) return false;
    if (s.expandedEditIndex === index) s.expandedEditIndex = undefined;
    else s.expandedEditIndex = index;
    const settings = getSettings(chatId);
    const text = clampText(renderFinished(s, s.expandedEditIndex, settings));
    const keyboard = finishedKeyboard(editDetails, s.expandedEditIndex, s);
    await tg.editRichMessage(chatId, messageId, text, {
      ...threadOptsFor(s),
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
    return true;
  };

  return { flushDraft, startStatus, updateStatus, finishStatus, showEditDiff };
}
