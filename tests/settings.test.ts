import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore, DEFAULT_SETTINGS } from "../src/settings.js";

const TEST_ROOT = "/tmp/opencode";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(TEST_ROOT, "ocg-settings-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("returns defaults for an unknown chat", () => {
    const store = new SettingsStore(dataDir);
    expect(store.get(100)).toEqual(DEFAULT_SETTINGS);
  });

  test("sets and reads a value", () => {
    const store = new SettingsStore(dataDir);
    const settings = store.set(100, "showThinking", false);
    expect(settings.showThinking).toBe(false);
    expect(store.get(100).showThinking).toBe(false);
  });

  test("toggles a value", () => {
    const store = new SettingsStore(dataDir);
    expect(store.toggle(100, "toolsExpanded").toolsExpanded).toBe(false);
    expect(store.toggle(100, "toolsExpanded").toolsExpanded).toBe(true);
  });

  test("persists and reloads settings", () => {
    const store = new SettingsStore(dataDir);
    store.set(100, "compactFinal", true);
    store.set(100, "voiceTranscription", false);

    const reloaded = new SettingsStore(dataDir);
    expect(reloaded.get(100).compactFinal).toBe(true);
    expect(reloaded.get(100).voiceTranscription).toBe(false);
    expect(reloaded.get(100).showThinking).toBe(true);
  });

  test("keeps chats isolated", () => {
    const store = new SettingsStore(dataDir);
    store.set(100, "showTools", false);
    expect(store.get(200).showTools).toBe(true);
  });
});
