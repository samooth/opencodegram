import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./util.js";

export type DiffStyle = "simple" | "unified";

export type ChatSettings = {
  showThinking: boolean;
  showTools: boolean;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
  showPartialText: boolean;
  autoArtifacts: boolean;
  voiceTranscription: boolean;
  compactFinal: boolean;
  showShell: boolean;
  shellExpanded: boolean;
  previewLines: number;
  diffStyle: DiffStyle;
};

export const DEFAULT_SETTINGS: ChatSettings = {
  showThinking: true,
  showTools: true,
  thinkingExpanded: false,
  toolsExpanded: true,
  showPartialText: true,
  autoArtifacts: true,
  voiceTranscription: true,
  compactFinal: false,
  showShell: true,
  shellExpanded: false,
  previewLines: 40,
  diffStyle: "simple",
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
    return { ...DEFAULT_SETTINGS, ...(this.settings.get(chatId) ?? {}) };
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
  autoArtifacts: "📎 Auto artifacts",
  voiceTranscription: "🎤 Voice transcription",
  compactFinal: "📦 Compact final",
  showShell: "🖥 Shell",
  shellExpanded: "🖥 Shell expanded",
  previewLines: "📏 Preview lines",
  diffStyle: "🧾 Diff style",
};

export function renderSettings(chatId: number, settings: ChatSettings): string {
  const sections: Array<{ title: string; keys: Array<keyof ChatSettings> }> = [
    { title: "Visualización", keys: ["showThinking", "showTools", "thinkingExpanded", "toolsExpanded", "showPartialText", "compactFinal"] },
    { title: "Shell", keys: ["showShell", "shellExpanded"] },
    { title: "Archivos", keys: ["autoArtifacts", "previewLines", "diffStyle"] },
    { title: "Voz", keys: ["voiceTranscription"] },
  ];
  const lines = [`<b>Settings</b>`, `Chat: <code>${chatId}</code>`, ""];
  for (const section of sections) {
    lines.push(`<b>${section.title}</b>`);
    for (const key of section.keys) {
      const value = settings[key];
      const display = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
      lines.push(`  ${LABELS[key]}: <b>${esc(display)}</b>`);
    }
    lines.push("");
  }
  lines.push("<i>Changes apply immediately.</i>");
  return lines.join("\n");
}

export function settingsKeyboard(settings: ChatSettings): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
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
  ];
  for (const key of booleanKeys) {
    keyboard.push([{ text: `${LABELS[key]}: ${settings[key] ? "on" : "off"}`, callback_data: `set:${key}:${settings[key] ? "false" : "true"}` }]);
  }
  const previewPresets = [20, 40, 80, 160];
  keyboard.push([{ text: `${LABELS.previewLines}: ${settings.previewLines}`, callback_data: `cycle:previewLines` }]);
  keyboard.push([{ text: `${LABELS.diffStyle}: ${settings.diffStyle}`, callback_data: `set:diffStyle:${settings.diffStyle === "simple" ? "unified" : "simple"}` }]);
  keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
  return keyboard;
}

export function isSettingsKey(value: string): value is keyof ChatSettings {
  return (SETTINGS_KEYS as string[]).includes(value);
}
