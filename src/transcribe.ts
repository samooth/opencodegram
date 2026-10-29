import { access, constants, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

export type TranscriptionConfig = {
  transcriber: string | undefined;
  args: string[] | undefined;
  language: string | undefined;
  timeoutMs: number;
  attachAudio: boolean;
};

export function loadTranscriptionConfig(config: Config): TranscriptionConfig {
  let args: string[] | undefined;
  if (config.VOICE_TRANSCRIBER_ARGS) {
    try {
      const parsed = JSON.parse(config.VOICE_TRANSCRIBER_ARGS);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        args = parsed;
      }
    } catch {
      args = undefined;
    }
  }
  return {
    transcriber: config.VOICE_TRANSCRIBER,
    args,
    language: config.VOICE_TRANSCRIPTION_LANGUAGE,
    timeoutMs: config.VOICE_TRANSCRIPTION_TIMEOUT_MS,
    attachAudio: config.VOICE_ATTACH_AUDIO,
  };
}

export async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH.
    }
  }
  return false;
}

function isWhisperCpp(command: string): boolean {
  const name = basename(command).toLowerCase();
  return name.includes("whisper") && (name.includes("cli") || name === "main" || name.includes("cpp"));
}

function defaultArgs(config: TranscriptionConfig, command: string): string[] {
  const name = basename(command).toLowerCase();
  if (name.includes("whisper") && (name.includes("cli") || name === "main")) {
    const args = ["-f", "{input}", "-otxt", "-of", "{output}"];
    if (config.language) args.push("-l", "{language}");
    return args;
  }
  // Generic fallback: pass the input path and rely on stdout.
  return ["{input}"];
}

export function buildArgs(config: TranscriptionConfig, command: string, inputPath: string, outputBase: string): string[] {
  const template = config.args && config.args.length ? config.args : defaultArgs(config, command);
  return template.map((arg) =>
    arg
      .replaceAll("{input}", inputPath)
      .replaceAll("{output}", outputBase)
      .replaceAll("{language}", config.language ?? "")
      .replaceAll("{outputDir}", dirname(outputBase)),
  );
}

async function convertToWav(inputPath: string, timeoutMs: number): Promise<string> {
  const ffmpegExists = await commandExists("ffmpeg");
  if (!ffmpegExists) {
    throw new Error("ffmpeg is required to convert this audio format");
  }
  const outputPath = join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.wav`);
  await execFileAsync(
    "ffmpeg",
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath],
    { timeout: timeoutMs },
  );
  return outputPath;
}

export async function transcribeFile(filePath: string, config: Config): Promise<string> {
  const transcriptionConfig = loadTranscriptionConfig(config);
  const command = transcriptionConfig.transcriber;
  if (!command) throw new Error("VOICE_TRANSCRIBER is not configured");
  if (!(await commandExists(command))) throw new Error(`Transcriber not found: ${command}`);

  const absoluteInput = resolve(filePath);
  const extension = extname(absoluteInput).toLowerCase();
  const needsConversion = /\.(ogg|opus|mp3|m4a|webm|mp4)$/i.test(absoluteInput) && isWhisperCpp(command);

  let audioPath = absoluteInput;
  let convertedPath: string | undefined;
  const outputBase = join(dirname(absoluteInput), `${basename(absoluteInput, extension)}-transcript`);

  try {
    if (needsConversion) {
      audioPath = await convertToWav(absoluteInput, transcriptionConfig.timeoutMs);
      convertedPath = audioPath;
    }

    const args = buildArgs(transcriptionConfig, command, audioPath, outputBase);
    const { stdout } = await execFileAsync(command, args, { timeout: transcriptionConfig.timeoutMs });
    const outputTextPath = `${outputBase}.txt`;

    let transcript = "";
    try {
      transcript = await readFile(outputTextPath, "utf8");
    } catch {
      transcript = stdout;
    }
    transcript = transcript.trim();
    if (!transcript) throw new Error("Transcription produced no text");
    return transcript;
  } finally {
    if (convertedPath) await rm(convertedPath, { force: true }).catch(() => {});
    await rm(`${outputBase}.txt`, { force: true }).catch(() => {});
  }
}

export function isTranscriptionEnabled(config: Config): boolean {
  const transcriptionConfig = loadTranscriptionConfig(config);
  return Boolean(transcriptionConfig.transcriber);
}

export async function transcriptionAvailable(config: Config): Promise<boolean> {
  const transcriptionConfig = loadTranscriptionConfig(config);
  if (!transcriptionConfig.transcriber) return false;
  return commandExists(transcriptionConfig.transcriber);
}
