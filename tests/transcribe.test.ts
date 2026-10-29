import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import {
  buildArgs,
  commandExists,
  isTranscriptionEnabled,
  loadTranscriptionConfig,
  transcriptionAvailable,
  transcribeFile,
} from "../src/transcribe.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-transcribe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    TELEGRAM_BOT_TOKEN: "test-token",
    OPENCODE_BASE_URL: "http://127.0.0.1:49374",
    LOG_LEVEL: "info",
    VOICE_TRANSCRIPTION_TIMEOUT_MS: 5000,
    VOICE_ATTACH_AUDIO: false,
    ...overrides,
  } as Config;
}

describe("transcription config", () => {
  test("parses JSON args and exposes the configuration", () => {
    const config = makeConfig({
      VOICE_TRANSCRIBER: "whisper-cli",
      VOICE_TRANSCRIBER_ARGS: '["-f","{input}","-otxt","-of","{output}"]',
      VOICE_TRANSCRIPTION_LANGUAGE: "es",
    });
    const parsed = loadTranscriptionConfig(config);
    expect(parsed.transcriber).toBe("whisper-cli");
    expect(parsed.args).toEqual(["-f", "{input}", "-otxt", "-of", "{output}"]);
    expect(parsed.language).toBe("es");
    expect(isTranscriptionEnabled(config)).toBe(true);
  });

  test("ignores invalid JSON args", () => {
    const config = makeConfig({
      VOICE_TRANSCRIBER: "whisper-cli",
      VOICE_TRANSCRIBER_ARGS: "{not json",
    });
    expect(loadTranscriptionConfig(config).args).toBeUndefined();
  });
});

describe("buildArgs", () => {
  test("replaces placeholders", () => {
    const config = loadTranscriptionConfig(
      makeConfig({
        VOICE_TRANSCRIBER: "demo",
        VOICE_TRANSCRIBER_ARGS: '["run","{input}","--out","{output}.txt","--lang","{language}"]',
        VOICE_TRANSCRIPTION_LANGUAGE: "es",
      }),
    );
    expect(buildArgs(config, "demo", "/tmp/in.ogg", "/tmp/out")).toEqual([
      "run",
      "/tmp/in.ogg",
      "--out",
      "/tmp/out.txt",
      "--lang",
      "es",
    ]);
  });

  test("uses whisper-cli defaults", () => {
    const config = loadTranscriptionConfig(makeConfig({ VOICE_TRANSCRIBER: "whisper-cli" }));
    expect(buildArgs(config, "whisper-cli", "/tmp/in.wav", "/tmp/out")).toEqual([
      "-f",
      "/tmp/in.wav",
      "-otxt",
      "-of",
      "/tmp/out",
    ]);
  });
});

describe("commandExists", () => {
  test("finds an executable in PATH", async () => {
    expect(await commandExists("sh")).toBe(true);
    expect(await commandExists("definitely-not-a-real-command")).toBe(false);
  });
});

describe("transcribeFile", () => {
  test("reads a transcript written by the configured command", async () => {
    const input = join(root, "voice.ogg");
    writeFileSync(input, Buffer.from([1, 2, 3]));
    const config = makeConfig({
      VOICE_TRANSCRIBER: "sh",
      VOICE_TRANSCRIBER_ARGS: '["-c","printf hello-transcript > {output}.txt"]',
    });
    const transcript = await transcribeFile(input, config);
    expect(transcript).toBe("hello-transcript");
  });

  test("falls back to stdout when no output file is produced", async () => {
    const input = join(root, "voice.ogg");
    writeFileSync(input, Buffer.from([1, 2, 3]));
    const config = makeConfig({
      VOICE_TRANSCRIBER: "printf",
      VOICE_TRANSCRIBER_ARGS: '["hello-stdout"]',
    });
    const transcript = await transcribeFile(input, config);
    expect(transcript).toBe("hello-stdout");
  });

  test("throws when the transcriber is missing", async () => {
    const input = join(root, "voice.ogg");
    writeFileSync(input, Buffer.from([1, 2, 3]));
    const config = makeConfig({ VOICE_TRANSCRIBER: "definitely-not-a-real-command" });
    await expect(transcribeFile(input, config)).rejects.toThrow("Transcriber not found");
  });

  test("reports availability", async () => {
    const availableConfig = makeConfig({ VOICE_TRANSCRIBER: "sh" });
    const missingConfig = makeConfig({ VOICE_TRANSCRIBER: "definitely-not-a-real-command" });
    expect(await transcriptionAvailable(availableConfig)).toBe(true);
    expect(await transcriptionAvailable(missingConfig)).toBe(false);
  });
});
