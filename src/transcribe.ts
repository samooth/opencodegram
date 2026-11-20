import { access, constants, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
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

type Invocation = { command: string; args: string[]; env?: NodeJS.ProcessEnv };

const invocationCache = new Map<string, Promise<Invocation>>();

function isPythonScript(command: string): boolean {
  if (extname(command).toLowerCase() === ".py") return true;
  try {
    const first = readFileSync(command, "utf8").split(/\r?\n/, 1)[0] ?? "";
    return first.startsWith("#!") && /python/i.test(first);
  } catch {
    return false;
  }
}

/** Python prefix lib dirs that contain libpython (pyenv needs them at runtime). */
function pythonLibDirs(python: string): string[] {
  const prefix = dirname(dirname(python));
  const dirs: string[] = [];
  for (const name of ["lib", "lib64"]) {
    const dir = join(prefix, name);
    try {
      if (readdirSync(dir).some((f) => f.startsWith("libpython") && f.includes(".so"))) dirs.push(dir);
    } catch {
      // Not a pyenv-style prefix.
    }
  }
  return dirs;
}

function pythonEnv(python: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dirs = pythonLibDirs(python);
  if (dirs.length) {
    const current = (env.LD_LIBRARY_PATH ?? "").split(delimiter).filter(Boolean);
    for (const dir of dirs.reverse()) {
      if (!current.includes(dir)) current.unshift(dir);
    }
    env.LD_LIBRARY_PATH = current.join(delimiter);
  }
  return env;
}

async function pythonWorks(python: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(python, ["-c", "import sys"], { timeout: 8_000, env });
    return true;
  } catch {
    return false;
  }
}

function shebangPython(script: string): string | undefined {
  try {
    const first = readFileSync(script, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!first.startsWith("#!")) return undefined;
    const parts = first.slice(2).trim().split(/\s+/);
    if (/\/env$/.test(parts[0] ?? "") && parts[1]) return parts[1];
    if (parts[0] && /python/i.test(parts[0])) return parts[0];
  } catch {
    // Ignore unreadable scripts; the caller reports a clearer error.
  }
  return undefined;
}

/**
 * A `.py` transcriber must run through a working Python. Moving a pyenv prefix
 * breaks the interpreter because it cannot find `libpythonX.Y.so`; adding the
 * prefix lib dir to LD_LIBRARY_PATH fixes it without touching the system.
 * VOICE_PYTHON is the explicit escape hatch.
 */
function resolvePython(candidate: string): string {
  if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
  let resolved = candidate;
  try {
    const which = execFileSync("command", ["-v", candidate], { encoding: "utf8", shell: true }).trim();
    if (which && existsSync(which)) resolved = which;
  } catch {
    // Fall through to the original candidate.
  }
  // pyenv shims are wrappers: resolve to the real interpreter so we can add
  // its libpython directory to LD_LIBRARY_PATH (and pick up its packages).
  if (resolved.includes("/.pyenv/shims/")) {
    const pyenvRoot = resolved.split("/.pyenv/shims/")[0] + "/.pyenv";
    try {
      const real = execFileSync(pyenvRoot + "/bin/pyenv", ["which", candidate], {
        encoding: "utf8",
        env: { ...process.env, PYENV_ROOT: pyenvRoot },
      }).trim();
      if (real && existsSync(real)) resolved = real;
    } catch {
      // Keep the shim; pythonWorks will report the failure.
    }
  }
  return resolved;
}

async function pythonInvocation(script: string, args: string[]): Promise<Invocation> {
  const cached = invocationCache.get(script);
  if (cached) {
    const base = await cached;
    return { ...base, args: [...base.args, ...args] };
  }
  const pending = (async (): Promise<Invocation> => {
    const candidates = [
      process.env.VOICE_PYTHON,
      shebangPython(script),
      "python3",
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ].filter((c): c is string => !!c);
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const resolved = resolvePython(candidate);
      if (seen.has(resolved) && resolved !== candidate) continue;
      seen.add(resolved);
      const env = pythonEnv(resolved);
      if (await pythonWorks(resolved, env)) {
        return { command: resolved, args: [script], env };
      }
      failures.push(candidate);
    }
    throw new Error(
      `No working Python found for ${script} (tried: ${failures.join(", ")}). ` +
      "Set VOICE_PYTHON to a working interpreter or restore its libpython.",
    );
  })();
  invocationCache.set(script, pending);
  // A transient probe failure must not poison the cache forever.
  pending.catch(() => invocationCache.delete(script));
  const base = await pending;
  return { ...base, args: [...base.args, ...args] };
}

async function buildInvocation(command: string, args: string[]): Promise<Invocation> {
  if (isPythonScript(command)) return pythonInvocation(command, args);
  return { command, args };
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
  // A Python script does not need its own +x bit: we run it through a working
  // interpreter (and add the pyenv lib dir when needed).
  if (!(await commandExists(command)) && !(isPythonScript(command) && existsSync(command))) {
    throw new Error(`Transcriber not found: ${command}`);
  }

  const absoluteInput = resolve(filePath);

  // Prefer the persistent daemon when configured (low latency).
  const daemonUrl = config.WHISPER_DAEMON_URL;
  if (daemonUrl) {
    try {
      const response = await fetch(`${daemonUrl.replace(/\/$/, "")}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: absoluteInput, language: transcriptionConfig.language ?? "auto" }),
        signal: AbortSignal.timeout(transcriptionConfig.timeoutMs),
      });
      if (!response.ok) throw new Error(`daemon returned ${response.status}`);
      const text = (await response.text()).trim();
      if (!text) throw new Error("daemon produced no text");
      return text;
    } catch (err) {
      console.warn("[transcribe] daemon failed, falling back to CLI", err instanceof Error ? err.message : String(err));
    }
  }

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
    const invocation = await buildInvocation(command, args);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      timeout: transcriptionConfig.timeoutMs,
      env: invocation.env,
    });
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

/**
 * Stream transcription: calls the daemon's SSE endpoint and emits accumulated
 * text via `onPartial`. Falls back to a single transcribeFile call if no daemon.
 */
export async function transcribeFileStreaming(
  filePath: string,
  config: Config,
  onPartial: (text: string) => void | Promise<void>,
): Promise<string> {
  const daemonUrl = config.WHISPER_DAEMON_URL;
  const absoluteInput = resolve(filePath);
  if (!daemonUrl) {
    const text = await transcribeFile(filePath, config);
    await onPartial(text);
    return text;
  }
  const transcriptionConfig = loadTranscriptionConfig(config);
  try {
    const response = await fetch(`${daemonUrl.replace(/\/$/, "")}/transcribe/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: absoluteInput, language: transcriptionConfig.language ?? "auto" }),
      signal: AbortSignal.timeout(transcriptionConfig.timeoutMs),
    });
    if (!response.ok || !response.body) throw new Error(`daemon stream returned ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let last = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload && payload !== "{}" && payload !== last) {
          last = payload;
          await onPartial(payload);
        }
      }
    }
    return last;
  } catch (err) {
    console.warn("[transcribe] stream failed, falling back", err instanceof Error ? err.message : String(err));
    const text = await transcribeFile(filePath, config);
    await onPartial(text);
    return text;
  }
}

export function isTranscriptionEnabled(config: Config): boolean {
  const transcriptionConfig = loadTranscriptionConfig(config);
  return Boolean(transcriptionConfig.transcriber);
}

export async function transcriptionAvailable(config: Config): Promise<boolean> {
  const transcriptionConfig = loadTranscriptionConfig(config);
  if (!transcriptionConfig.transcriber) return false;
  const command = transcriptionConfig.transcriber;
  if (await commandExists(command)) return true;
  return isPythonScript(command) && existsSync(command);
}
