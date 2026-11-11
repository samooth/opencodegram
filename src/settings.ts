import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./util.js";

export type DiffStyle = "simple" | "unified";
/** Where the session card lives and whether its previous messages are preserved. */
export type CardBehavior = "fixed" | "refloat" | "refloat_keep";
/** High-level layout: unified dashboard+conversation (2 messages) or flexible. */
export type DisplayMode = "unified" | "flexible";
/** How long final answers are delivered. */
export type LongAnswerDelivery = "card" | "message" | "auto";

export type ChatSettings = {
  showThinking: boolean;
  showTools: boolean;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
  showPartialText: boolean;
  partialTextLines: number;
  autoArtifacts: boolean;
  voiceTranscription: boolean;
  compactFinal: boolean;
  showShell: boolean;
  shellExpanded: boolean;
  previewLines: number;
  diffStyle: DiffStyle;
  showResourceUsage: boolean;
  resourceHistory: number;
  showLatestThought: boolean;
  showLatestTool: boolean;
  showTokenSpeed: boolean;
  showCot: boolean;
  showToolInput: boolean;
  autoTopicTitle: boolean;
  sessionNameInMessages: boolean;
  showSessionNameInStatus: boolean;
  /** Where the session card lives: edited in place, or re-sent at the bottom on each turn. */
  cardBehavior: CardBehavior;
  /** Unified = pinned dashboard + one conversation message; flexible = current behavior. */
  displayMode: DisplayMode;
  /** Deliver long final answers in-card, as a separate message, or automatically by threshold. */
  longAnswerDelivery: LongAnswerDelivery;
  /** Character threshold used when longAnswerDelivery is "auto". */
  longAnswerThreshold: number;
};

export const DEFAULT_SETTINGS: ChatSettings = {
  showThinking: true,
  showTools: true,
  thinkingExpanded: false,
  toolsExpanded: true,
  showPartialText: true,
  partialTextLines: 500,
  autoArtifacts: true,
  voiceTranscription: true,
  compactFinal: false,
  showShell: true,
  shellExpanded: false,
  previewLines: 40,
  diffStyle: "simple",
  showResourceUsage: true,
  resourceHistory: 12,
  showLatestThought: true,
  showLatestTool: true,
  showTokenSpeed: true,
  showCot: true,
  showToolInput: true,
  autoTopicTitle: true,
  sessionNameInMessages: true,
  showSessionNameInStatus: true,
  cardBehavior: "fixed",
  displayMode: "flexible",
  longAnswerDelivery: "auto",
  longAnswerThreshold: 1800,
};

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof ChatSettings>;

export class SettingsStore {
  private readonly file: string;
  private readonly settings = new Map<number, Partial<ChatSettings>>();

  constructor(dataDir = join(process.cwd(), "data")) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "settings.json");
    this.load();
  }

  get(chatId: number): ChatSettings {
    const merged = { ...DEFAULT_SETTINGS, ...(this.settings.get(chatId) ?? {}) };
    if (merged.cardBehavior !== "fixed" && merged.cardBehavior !== "refloat" && merged.cardBehavior !== "refloat_keep") {
      merged.cardBehavior = DEFAULT_SETTINGS.cardBehavior;
    }
    if (merged.displayMode !== "unified" && merged.displayMode !== "flexible") {
      merged.displayMode = DEFAULT_SETTINGS.displayMode;
    }
    if (merged.longAnswerDelivery !== "card" && merged.longAnswerDelivery !== "message" && merged.longAnswerDelivery !== "auto") {
      merged.longAnswerDelivery = DEFAULT_SETTINGS.longAnswerDelivery;
    }
    if (typeof merged.longAnswerThreshold !== "number" || !Number.isFinite(merged.longAnswerThreshold) || merged.longAnswerThreshold < 200) {
      merged.longAnswerThreshold = DEFAULT_SETTINGS.longAnswerThreshold;
    }
    return merged;
  }

  set(chatId: number, key: keyof ChatSettings, value: ChatSettings[keyof ChatSettings]): ChatSettings {
    const current = this.settings.get(chatId) ?? {};
    (current as Record<string, unknown>)[key] = value;
    this.settings.set(chatId, current);
    this.save();
    return this.get(chatId);
  }

  toggle(chatId: number, key: keyof ChatSettings): ChatSettings {
    const current = this.get(chatId);
    const value = current[key];
    if (typeof value === "boolean") return this.set(chatId, key, !value);
    return current;
  }

  private save(): void {
    try {
      const obj: Record<string, Partial<ChatSettings>> = {};
      for (const [chatId, settings] of this.settings) obj[String(chatId)] = settings;
      writeFileSync(this.file, JSON.stringify(obj, null, 2));
    } catch {
      // Settings are a convenience; never break the bot.
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Partial<ChatSettings>>;
      for (const [chatId, settings] of Object.entries(parsed)) {
        const id = Number(chatId);
        if (!Number.isFinite(id)) continue;
        this.settings.set(id, settings ?? {});
      }
    } catch {
      // Ignore corrupt settings and fall back to defaults.
    }
  }
}

export const LABELS: Record<keyof ChatSettings, string> = {
  showThinking: "🧠 Thinking",
  showTools: "🔧 Tools",
  thinkingExpanded: "🧠 Thinking expanded",
  toolsExpanded: "🔧 Tools expanded",
  showPartialText: "📝 Partial text",
  partialTextLines: "📏 Partial text chars",
  autoArtifacts: "📎 Auto artifacts",
  voiceTranscription: "🎤 Voice transcription",
  compactFinal: "📦 Compact final",
  showShell: "🖥 Shell",
  shellExpanded: "🖥 Shell expanded",
  previewLines: "📏 Preview lines",
  diffStyle: "🧾 Diff style",
  showResourceUsage: "📊 Resource usage",
  resourceHistory: "📈 History size",
  showLatestThought: "💭 Latest thought",
  showLatestTool: "🔧 Latest tool",
  showTokenSpeed: "⚡ Token speed",
  showCot: "🧾 COT (finished)",
  showToolInput: "⌨️ Tool input",
  autoTopicTitle: "🏷 Auto topic title",
  sessionNameInMessages: "📌 Session name in messages",
  showSessionNameInStatus: "📌 Session name in status",
  cardBehavior: "📍 Ubicación tarjeta",
  displayMode: "🧩 Modo",
  longAnswerDelivery: "📤 Respuesta larga",
  longAnswerThreshold: "📏 Umbral respuesta",
};

export function renderSettings(chatId: number, settings: ChatSettings): string {
  const sections: Array<{ title: string; emoji: string; keys: Array<keyof ChatSettings> }> = [
    { title: "Modo y entrega", emoji: "🧩", keys: ["displayMode", "cardBehavior", "longAnswerDelivery", "longAnswerThreshold"] },
    { title: "Visualización", emoji: "👁", keys: ["showThinking", "showTools", "showCot", "showLatestThought", "showLatestTool", "showTokenSpeed", "showPartialText", "partialTextLines", "compactFinal", "showSessionNameInStatus", "sessionNameInMessages", "autoTopicTitle"] },
    { title: "Shell", emoji: "🖥", keys: ["showShell", "shellExpanded", "showToolInput"] },
    { title: "Archivos", emoji: "📁", keys: ["autoArtifacts", "previewLines", "diffStyle"] },
    { title: "Voz", emoji: "🎤", keys: ["voiceTranscription"] },
    { title: "Recursos", emoji: "📊", keys: ["showResourceUsage", "resourceHistory"] },
  ];
  const lines = [`<b>⚙️ Settings</b>`, `Chat: <code>${chatId}</code>`, ""];
  for (const section of sections) {
    const maxLabel = Math.max(...section.keys.map((k) => (LABELS[k].replace(/^[^ ]+ /, "").length)), 8);
    const rows = section.keys.map((key) => {
      const value = settings[key];
      const display = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
      const label = LABELS[key].replace(/^[^ ]+ /, "");
      return `${label.padEnd(maxLabel, " ")}  ${display}`;
    });
    const body = `<pre>${rows.map(esc).join("\n")}</pre>`;
    const header = `${section.emoji} <b>${section.title}</b>`;
    // Long sections are collapsible to reduce initial scroll.
    if (section.keys.length >= 5) {
      lines.push(`<blockquote expandable>${header}\n${body}</blockquote>`);
    } else {
      lines.push(`<blockquote>${header}\n${body}</blockquote>`);
    }
    lines.push("");
  }
  lines.push("<i>Los cambios se aplican inmediatamente.</i>");
  return lines.join("\n");
}

export function settingsKeyboard(settings: ChatSettings): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  keyboard.push([
    { text: "Perfil: Unificado", callback_data: "profile:unified" },
    { text: "Perfil: Unificado+msg", callback_data: "profile:unified_split" },
    { text: "Perfil: Flexible", callback_data: "profile:flexible" },
  ]);

  keyboard.push([
    { text: `🧩 Modo: ${settings.displayMode === "unified" ? "unificado" : "flexible"}`, callback_data: `set:displayMode:${settings.displayMode === "unified" ? "flexible" : "unified"}` },
  ]);

  const deliveryLabels: Record<LongAnswerDelivery, string> = { card: "en tarjeta", message: "mensaje aparte", auto: "auto" };
  const deliveryCycle: Record<LongAnswerDelivery, LongAnswerDelivery> = { card: "message", message: "auto", auto: "card" };
  keyboard.push([
    { text: `📤 Respuesta larga: ${deliveryLabels[settings.longAnswerDelivery]}`, callback_data: `set:longAnswerDelivery:${deliveryCycle[settings.longAnswerDelivery]}` },
    { text: `📏 Umbral: ${settings.longAnswerThreshold}`, callback_data: "cycle:longAnswerThreshold" },
  ]);

  {
    const cardLabels: Record<CardBehavior, string> = {
      fixed: "fija",
      refloat: "reflotar",
      refloat_keep: "reflotar (conservar)",
    };
    const cardCycle: Record<CardBehavior, CardBehavior> = {
      fixed: "refloat",
      refloat: "refloat_keep",
      refloat_keep: "fixed",
    };
    const behavior: CardBehavior = cardLabels[settings.cardBehavior] ? settings.cardBehavior : "fixed";
    keyboard.push([
      {
        text: `📍 Tarjeta: ${cardLabels[behavior]}`,
        callback_data: `set:cardBehavior:${cardCycle[behavior]}`,
      },
    ]);
  }

  const booleanKeys: Array<keyof ChatSettings> = [
    "showThinking",
    "showTools",
    "thinkingExpanded",
    "toolsExpanded",
    "showPartialText",
    "autoArtifacts",
    "voiceTranscription",
    "compactFinal",
    "showShell",
    "shellExpanded",
    "showResourceUsage",
    "showCot",
    "showLatestThought",
    "showLatestTool",
    "showTokenSpeed",
    "showToolInput",
    "autoTopicTitle",
    "sessionNameInMessages",
    "showSessionNameInStatus",
  ];
  // Two buttons per row for compactness.
  for (let i = 0; i < booleanKeys.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    for (let j = i; j < Math.min(i + 2, booleanKeys.length); j++) {
      const key = booleanKeys[j];
      row.push({ text: `${settings[key] ? "✅" : "❌"} ${LABELS[key]}`, callback_data: `set:${key}:${settings[key] ? "false" : "true"}` });
    }
    keyboard.push(row);
  }
  keyboard.push([
    { text: `📏 Preview: ${settings.previewLines}`, callback_data: `cycle:previewLines` },
    { text: `📈 History: ${settings.resourceHistory}`, callback_data: `cycle:resourceHistory` },
  ]);
  keyboard.push([{ text: `🧾 Diff: ${settings.diffStyle}`, callback_data: `set:diffStyle:${settings.diffStyle === "simple" ? "unified" : "simple"}` }]);
  keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
  return keyboard;
}

export function isSettingsKey(value: string): value is keyof ChatSettings {
  return (SETTINGS_KEYS as string[]).includes(value);
}
