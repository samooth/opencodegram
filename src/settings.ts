import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./util.js";
import { logger } from "./logger.js";
import { readJsonSafe, writeJsonAtomic } from "./persist.js";

export type DiffStyle = "simple" | "unified";
/** Where the session card lives and whether its previous messages are preserved. */
export type CardBehavior = "fixed" | "refloat" | "refloat_keep";
/** High-level layout: unified dashboard+conversation (2 messages) or flexible. */
export type DisplayMode = "unified" | "flexible";
/** How long final answers are delivered. */
export type LongAnswerDelivery = "card" | "message" | "auto";
/** Card visual theme (auto uses neutral glyphs that work in both themes). */
export type CardTheme = "auto" | "light" | "dark";
/** Card verbosity mapped from OpenCode 2.3.0 session.verbosity. */
export type CardVerbosity = "low" | "medium" | "high";
/** Named style bundles that can be applied from /settings and persisted per chat. */
export type CardPreset = "minimal" | "balanced" | "verbose" | "terminal";

export const CARD_PRESETS: CardPreset[] = ["minimal", "balanced", "verbose", "terminal"];

export const PRESET_LABELS: Record<CardPreset, string> = {
  minimal: "Minimal",
  balanced: "Balanceado",
  verbose: "Detallado",
  terminal: "Terminal",
};

/** Overlay applied on top of the current settings when a preset is selected. */
export const PRESET_SETTINGS: Record<CardPreset, Partial<ChatSettings>> = {
  minimal: {
    compactCard: true,
    showActionRail: false,
    showFinalInCard: false,
    cardVerbosity: "low",
    showThinking: false,
    showTools: false,
    showCot: false,
    showLatestThought: false,
    showLatestTool: false,
    showPartialText: false,
    showResourceUsage: false,
    showSessionNameInStatus: false,
    thinkingExpanded: false,
    toolsExpanded: false,
    compactFinal: true,
  },
  balanced: {
    compactCard: true,
    showActionRail: true,
    showFinalInCard: true,
    cardVerbosity: "medium",
    showThinking: true,
    showTools: true,
    showCot: true,
    showLatestThought: true,
    showLatestTool: true,
    showPartialText: true,
    showResourceUsage: true,
    showSessionNameInStatus: true,
    thinkingExpanded: false,
    toolsExpanded: true,
    compactFinal: false,
  },
  verbose: {
    compactCard: false,
    showActionRail: true,
    showFinalInCard: true,
    cardVerbosity: "high",
    showThinking: true,
    showTools: true,
    showCot: true,
    showLatestThought: true,
    showLatestTool: true,
    showPartialText: true,
    showResourceUsage: true,
    showSessionNameInStatus: true,
    showToolInput: true,
    thinkingExpanded: true,
    toolsExpanded: true,
    compactFinal: false,
  },
  terminal: {
    compactCard: true,
    showActionRail: true,
    showFinalInCard: true,
    cardVerbosity: "medium",
    diffStyle: "unified",
    showShell: true,
    shellExpanded: true,
    showToolInput: true,
    showTokenSpeed: true,
    showThinking: false,
    showPartialText: true,
    showCot: false,
    cardTheme: "dark",
    thinkingExpanded: false,
    toolsExpanded: true,
  },
};

/** Pure helper: settings as they would look after applying a preset. */
export function withPreset(settings: ChatSettings, preset: CardPreset): ChatSettings {
  return { ...settings, ...PRESET_SETTINGS[preset], cardPreset: preset };
}

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
  cardTheme: CardTheme;
  cardVerbosity: CardVerbosity;
  /** Persistent style bundle selected in /settings. */
  cardPreset: CardPreset;
  /** P1.1: keep the default card short, with ≤3 keyboard rows. */
  compactCard: boolean;
  /** P1.2: show the last three actions as a live pipeline. */
  showActionRail: boolean;
  /** Show the final answer directly in the finished card by default. */
  showFinalInCard: boolean;
  /** P2: react with 🎉 when a turn finishes successfully. */
  celebrateOnDone: boolean;
  /** P2: onboarding step already shown to this chat. */
  onboardingStep: number;
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
  cardTheme: "auto",
  cardVerbosity: "medium",
  cardPreset: "balanced",
  compactCard: true,
  showActionRail: true,
  showFinalInCard: true,
  celebrateOnDone: false,
  onboardingStep: 0,
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
    if (merged.cardTheme !== "auto" && merged.cardTheme !== "light" && merged.cardTheme !== "dark") {
      merged.cardTheme = DEFAULT_SETTINGS.cardTheme;
    }
    if (merged.cardVerbosity !== "low" && merged.cardVerbosity !== "medium" && merged.cardVerbosity !== "high") {
      merged.cardVerbosity = DEFAULT_SETTINGS.cardVerbosity;
    }
    if (!CARD_PRESETS.includes(merged.cardPreset)) merged.cardPreset = DEFAULT_SETTINGS.cardPreset;
    if (!Number.isFinite(merged.onboardingStep) || merged.onboardingStep < 0) merged.onboardingStep = 0;
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

  /** Apply a style bundle and persist it for this chat. */
  applyPreset(chatId: number, preset: CardPreset): ChatSettings {
    const selected = CARD_PRESETS.includes(preset) ? preset : DEFAULT_SETTINGS.cardPreset;
    const current = this.settings.get(chatId) ?? {};
    this.settings.set(chatId, { ...current, ...PRESET_SETTINGS[selected], cardPreset: selected });
    this.save();
    return this.get(chatId);
  }

  private save(): void {
    try {
      const obj: Record<string, Partial<ChatSettings>> = {};
      for (const [chatId, settings] of this.settings) obj[String(chatId)] = settings;
      writeJsonAtomic(this.file, obj);
    } catch (err) {
      // Settings are a convenience; never break the bot, but do not hide the
      // failure: a full disk would silently lose every toggle.
      logger.error("settings", "save failed", err);
    }
  }

  private load(): void {
    const parsed = readJsonSafe<Record<string, Partial<ChatSettings>>>(this.file, "settings");
    if (!parsed) return;
    for (const [chatId, settings] of Object.entries(parsed)) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) continue;
      this.settings.set(id, settings ?? {});
    }
  }
}

export const LABELS: Record<keyof ChatSettings, string> = {
  showThinking: "🧠 Razonamiento",
  showTools: "🔧 Herramientas",
  thinkingExpanded: "🧠 Razonamiento expandido",
  toolsExpanded: "🔧 Herramientas expandidas",
  showPartialText: "📝 Texto parcial",
  partialTextLines: "📏 Caracteres de texto parcial",
  autoArtifacts: "📎 Artefactos automáticos",
  voiceTranscription: "🎤 Transcripción de voz",
  compactFinal: "📦 Respuesta compacta",
  showShell: "🖥 Shell",
  shellExpanded: "🖥 Shell expandido",
  previewLines: "📏 Líneas de preview",
  diffStyle: "🧾 Estilo de diff",
  showResourceUsage: "📊 Uso de recursos",
  resourceHistory: "📈 Tamaño del historial",
  showLatestThought: "💭 Último pensamiento",
  showLatestTool: "🔧 Última herramienta",
  showTokenSpeed: "⚡ Velocidad de tokens",
  showCot: "🧾 COT (al terminar)",
  showToolInput: "⌨️ Entrada de herramientas",
  autoTopicTitle: "🏷 Título automático del tema",
  sessionNameInMessages: "📌 Nombre de sesión en mensajes",
  showSessionNameInStatus: "📌 Nombre de sesión en el card",
  cardBehavior: "📍 Ubicación tarjeta",
  displayMode: "🧩 Modo",
  longAnswerDelivery: "📤 Respuesta larga",
  longAnswerThreshold: "📏 Umbral respuesta",
  cardTheme: "🎨 Tema del card",
  cardVerbosity: "📊 Verbosidad",
  cardPreset: "🎛 Estilo",
  compactCard: "📏 Card compacto",
  showActionRail: "⚡ Rail de acciones",
  showFinalInCard: "💬 Respuesta en el card",
  celebrateOnDone: "🎉 Celebración",
  onboardingStep: "🎓 Onboarding",
};

export function renderSettings(chatId: number, settings: ChatSettings): string {
  const sections: Array<{ title: string; emoji: string; keys: Array<keyof ChatSettings> }> = [
    { title: "Modo y entrega", emoji: "🧩", keys: ["displayMode", "cardBehavior", "longAnswerDelivery", "longAnswerThreshold", "cardPreset"] },
    { title: "Accesibilidad y feedback", emoji: "♿", keys: ["celebrateOnDone"] },
    { title: "Visualización", emoji: "👁", keys: ["showThinking", "showTools", "showCot", "showLatestThought", "showLatestTool", "showTokenSpeed", "showPartialText", "partialTextLines", "compactFinal", "showSessionNameInStatus", "sessionNameInMessages", "autoTopicTitle", "compactCard", "showActionRail", "showFinalInCard", "celebrateOnDone"] },
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
      const display = typeof value === "boolean" ? (value ? "sí" : "no") : String(value);
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

  // P1.6: style presets are one tap away and persist per chat.
  keyboard.push(CARD_PRESETS.map((preset) => ({
    text: `${settings.cardPreset === preset ? "✅ " : ""}${PRESET_LABELS[preset]}`,
    callback_data: `preset:${preset}`,
  })));

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
      fixed: "fija (edita en sitio)",
      refloat: "única (borra anterior)",
      refloat_keep: "nueva (conserva anterior)",
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

  {
    const verbLabels: Record<CardVerbosity, string> = { low: "baja", medium: "media", high: "alta" };
    const verbCycle: Record<CardVerbosity, CardVerbosity> = { low: "medium", medium: "high", high: "low" };
    const v = verbLabels[settings.cardVerbosity] ? settings.cardVerbosity : "medium";
    keyboard.push([
      { text: `📊 Verbosidad: ${verbLabels[v]}`, callback_data: `set:cardVerbosity:${verbCycle[v]}` },
    ]);
  }

  {
    const themeLabels: Record<CardTheme, string> = { auto: "auto", light: "claro", dark: "oscuro" };
    const themeCycle: Record<CardTheme, CardTheme> = { auto: "light", light: "dark", dark: "auto" };
    const theme = themeLabels[settings.cardTheme] ? settings.cardTheme : "auto";
    keyboard.push([
      { text: `🎨 Tema: ${themeLabels[theme]}`, callback_data: `set:cardTheme:${themeCycle[theme]}` },
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
    "compactCard",
    "showActionRail",
    "showFinalInCard",
    "celebrateOnDone",
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
