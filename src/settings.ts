import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./util.js";

export type ChatSettings = {
  showThinking: boolean;
  showTools: boolean;
  thinkingExpanded: boolean;
  toolsExpanded: boolean;
  showPartialText: boolean;
  autoArtifacts: boolean;
  voiceTranscription: boolean;
  compactFinal: boolean;
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

  set(chatId: number, key: keyof ChatSettings, value: boolean): ChatSettings {
    const current = this.settings.get(chatId) ?? {};
    current[key] = value;
    this.settings.set(chatId, current);
    this.save();
    return this.get(chatId);
  }

  toggle(chatId: number, key: keyof ChatSettings): ChatSettings {
    return this.set(chatId, key, !this.get(chatId)[key]);
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
};

export function renderSettings(chatId: number, settings: ChatSettings): string {
  const sections: Array<{ title: string; keys: Array<keyof ChatSettings> }> = [
    { title: "Visualización", keys: ["showThinking", "showTools", "thinkingExpanded", "toolsExpanded", "showPartialText", "compactFinal"] },
    { title: "Archivos", keys: ["autoArtifacts"] },
    { title: "Voz", keys: ["voiceTranscription"] },
  ];
  const lines = [`<b>Settings</b>`, `Chat: <code>${chatId}</code>`, ""];
  for (const section of sections) {
    lines.push(`<b>${section.title}</b>`);
    for (const key of section.keys) {
      lines.push(`  ${LABELS[key]}: <b>${settings[key] ? "on" : "off"}</b>`);
    }
    lines.push("");
  }
  lines.push("<i>Changes apply immediately.</i>");
  return lines.join("\n");
}

export function settingsKeyboard(settings: ChatSettings): Array<Array<{ text: string; callback_data: string }>> {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const key of SETTINGS_KEYS) {
    keyboard.push([{ text: `${LABELS[key]}: ${settings[key] ? "on" : "off"}`, callback_data: `set:${key}:${settings[key] ? "false" : "true"}` }]);
  }
  keyboard.push([{ text: "🏠 Panel", callback_data: "panel:home" }]);
  return keyboard;
}

export function isSettingsKey(value: string): value is keyof ChatSettings {
  return (SETTINGS_KEYS as string[]).includes(value);
}
