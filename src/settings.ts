import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./util.js";
import { logger } from "./logger.js";
import { jsonRead, jsonWrite } from "./db.js";

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
  /** Render all collapsible card sections expanded by default. */
  sectionsExpanded: boolean;
  /** Publish prompts typed in OpenCode's TUI to the Telegram route. */
  showTuiPrompts: boolean;
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
  sectionsExpanded: true,
  showTuiPrompts: true,
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
      jsonWrite(this.file, obj);
    } catch (err) {
      // Settings are a convenience; never break the bot, but do not hide the
      // failure: a full disk would silently lose every toggle.
      logger.error("settings", "save failed", err);
    }
  }

  private load(): void {
    const parsed = jsonRead<Record<string, Partial<ChatSettings>>>(this.file, "settings");
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
  sectionsExpanded: "📂 Secciones expandidas",
  showTuiPrompts: "⌨️ Prompts desde TUI",
  onboardingStep: "🎓 Onboarding",
};

export function settingsKeyboard(settings: ChatSettings): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  // Simplified settings: one profile selector + a handful of global toggles.
  keyboard.push([{ text: "◀ Volver", callback_data: "settings:back" }]);

  // Profile selector: a single tap applies a complete visual behaviour.
  keyboard.push(CARD_PRESETS.map((preset) => ({
    text: `${settings.cardPreset === preset ? "✅ " : ""}${PRESET_LABELS[preset]}`,
    callback_data: `preset:${preset}`,
  })));

  // Display mode: unified (dashboard) vs flexible (per-session cards).
  keyboard.push([
    { text: `🖥 Unificado: ${settings.displayMode === "unified" ? "sí" : "no"}`, callback_data: `set:displayMode:${settings.displayMode === "unified" ? "flexible" : "unified"}` },
  ]);

  // Global toggles (independent of the profile).
  keyboard.push([
    { text: `${settings.showResourceUsage ? "✅" : "❌"} 📊 Recursos`, callback_data: `set:showResourceUsage:${settings.showResourceUsage ? "false" : "true"}` },
    { text: `🎨 Tema: ${settings.cardTheme}`, callback_data: `set:cardTheme:${settings.cardTheme === "auto" ? "light" : settings.cardTheme === "light" ? "dark" : "auto"}` },
  ]);
  keyboard.push([
    { text: `🧾 Diff: ${settings.diffStyle}`, callback_data: `set:diffStyle:${settings.diffStyle === "simple" ? "unified" : "simple"}` },
    { text: `${settings.showFinalInCard ? "✅" : "❌"} 💬 Respuesta en tarjeta`, callback_data: `set:showFinalInCard:${settings.showFinalInCard ? "false" : "true"}` },
  ]);
  keyboard.push([
    { text: `${settings.sectionsExpanded ? "✅" : "❌"} 📂 Secciones expandidas`, callback_data: `set:sectionsExpanded:${settings.sectionsExpanded ? "false" : "true"}` },
  ]);
  keyboard.push([
    { text: `${settings.showTuiPrompts ? "✅" : "❌"} ⌨️ Prompts TUI`, callback_data: `set:showTuiPrompts:${settings.showTuiPrompts ? "false" : "true"}` },
  ]);
  keyboard.push([
    { text: `📏 Preview: ${settings.previewLines}`, callback_data: `cycle:previewLines` },
    { text: `📈 History: ${settings.resourceHistory}`, callback_data: `cycle:resourceHistory` },
  ]);

  return keyboard;
}

/** Compact settings view: buttons only, no long explanation block. */
export function renderSettingsPanel(chatId: number, settings: ChatSettings): string {
  const profile = settings.displayMode === "unified" ? "Unificado" : "Flexible";
  const preset = PRESET_LABELS[settings.cardPreset] ?? PRESET_LABELS[DEFAULT_SETTINGS.cardPreset];
  return `⚙️ <b>Ajustes</b> · <code>${chatId}</code>\n<i>${profile} · ${esc(preset)}</i>\n<i>Toca un botón para cambiarlo; ◀ Volver cierra este panel.</i>`;
}

export function isSettingsKey(value: string): value is keyof ChatSettings {
  return (SETTINGS_KEYS as string[]).includes(value);
}
