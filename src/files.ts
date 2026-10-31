import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { esc } from "./util.js";

/**
 * Filesystem helpers used by the Telegram file browser.
 *
 * Every public function receives a trusted `base` directory (the active
 * session directory) and an untrusted path from Telegram. `resolveSafePath`
 * resolves symlinks and rejects anything that ends up outside `base`.
 */

export type FileEntryType = "file" | "directory" | "symlink";

export type FileEntry = {
  name: string;
  /** Path relative to the session directory, always POSIX-style. */
  path: string;
  type: FileEntryType;
  size: number;
  mtime: number;
  symlink: boolean;
  /** Symlink that points outside the session directory or is broken. */
  external: boolean;
};

const execFileAsync = promisify(execFile);

export type SafePath = {
  /** Real path of the session directory. */
  base: string;
  /** Real absolute path of the target. */
  absolute: string;
  /** Target path relative to `base`, POSIX-style. Empty for the base itself. */
  relative: string;
};

export type DirListing = {
  base: string;
  /** Relative path of the listed directory (empty for the base). */
  path: string;
  absolute: string;
  entries: FileEntry[];
  total: number;
  truncated: boolean;
};

export type FindResult = {
  base: string;
  entries: FileEntry[];
  scanned: number;
  truncated: boolean;
};

export type ReadResult = {
  base: string;
  absolute: string;
  relative: string;
  size: number;
  text: string;
  /** 1-based line where the preview starts. */
  startLine: number;
  /** 1-based line where the preview ends (inclusive). */
  endLine: number;
  /** Total lines when the whole file was read, otherwise undefined. */
  totalLines?: number;
  truncated: boolean;
};

export type SearchMatch = {
  line: number;
  text: string;
};

export type SearchResult = {
  base: string;
  absolute: string;
  relative: string;
  size: number;
  pattern: string;
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
};

export type FileSummary = {
  path: string;
  relative: string;
  size: number;
  lines: number;
  language: string;
  imports: string[];
  exports: string[];
  symbols: Array<{ kind: string; name: string; line: number }>;
  sections: string[];
  head: string[];
  tail: string[];
  truncated: boolean;
};

const SYMBOL_PATTERNS: Record<string, Array<{ kind: string; re: RegExp }>> = {
  ts: [
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+(\w+)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+(\w+)\s*=/ },
    { kind: "let", re: /^\s*(?:export\s+)?let\s+(\w+)/ },
  ],
  js: [
    { kind: "class", re: /^\s*(?:export\s+)?class\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+(\w+)\s*=/ },
  ],
  py: [
    { kind: "class", re: /^\s*class\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:async\s+)?def\s+(\w+)/ },
    { kind: "import", re: /^\s*(?:from\s+\S+\s+)?import\s+(.+)/ },
  ],
  go: [
    { kind: "struct", re: /^\s*type\s+(\w+)\s+struct/ },
    { kind: "interface", re: /^\s*type\s+(\w+)\s+interface/ },
    { kind: "function", re: /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/ },
    { kind: "const", re: /^\s*const\s+(\w+)/ },
    { kind: "var", re: /^\s*var\s+(\w+)/ },
  ],
  rs: [
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+(\w+)/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?enum\s+(\w+)/ },
    { kind: "trait", re: /^\s*(?:pub\s+)?trait\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:pub\s+)?const\s+(\w+)/ },
    { kind: "mod", re: /^\s*(?:pub\s+)?mod\s+(\w+)/ },
  ],
  zig: [
    { kind: "struct", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*struct/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*enum/ },
    { kind: "union", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*union/ },
    { kind: "function", re: /^\s*(?:pub\s+)?fn\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:pub\s+)?const\s+(\w+)/ },
    { kind: "var", re: /^\s*(?:pub\s+)?var\s+(\w+)/ },
  ],
  c: [
    { kind: "struct", re: /^\s*(?:typedef\s+)?struct\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:\w+[\s*]+)+?(\w+)\s*\([^)]*\)\s*\{/ },
    { kind: "define", re: /^\s*#define\s+(\w+)/ },
  ],
  java: [
    { kind: "class", re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/ },
    { kind: "interface", re: /^\s*(?:public\s+)?interface\s+(\w+)/ },
    { kind: "method", re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+?(\w+)\s*\([^)]*\)\s*\{/ },
  ],
};

const IMPORT_PATTERNS: Record<string, RegExp> = {
  ts: /^\s*import\s+.+from\s+["']([^"']+)["']/,
  js: /^\s*import\s+.+from\s+["']([^"']+)["']/,
  py: /^\s*(?:from\s+(\S+)\s+import|import\s+(.+))/,
  go: /^\s*import\s+(?:\()?\s*["']([^"']+)["']/,
  rs: /^\s*use\s+([^;]+);/,
  zig: /^\s*const\s+\w+\s*=\s*@import\("([^"]+)"\)/,
  c: /^\s*#include\s+[<"]([^>"]+)[>"]/,
  java: /^\s*import\s+([^;]+);/,
};

const EXPORT_PATTERNS: Record<string, RegExp> = {
  ts: /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+(\w+)/,
  js: /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/,
  zig: /^\s*pub\s+(?:fn|const|var)\s+(\w+)/,
  rs: /^\s*pub\s+(?:fn|struct|enum|const|mod|trait)\s+(\w+)/,
  go: /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
};

function detectLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
    js: "js", jsx: "js", mjs: "js", cjs: "js",
    py: "py", pyi: "py",
    go: "go",
    rs: "rs",
    zig: "zig",
    c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c",
    java: "java",
    md: "md", markdown: "md",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  };
  return map[ext] ?? "text";
}

export async function summarizeFile(base: string, input: string): Promise<FileSummary> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isFile()) throw new FileAccessError("not_file", "That path is not a file.");

  const MAX = 256 * 1024;
  const truncated = st.size > MAX;
  let buffer: Buffer;
  if (truncated) {
    const handle = await open(safe.absolute, "r");
    try {
      const chunk = Buffer.alloc(MAX);
      const { bytesRead } = await handle.read(chunk, 0, MAX, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    buffer = await readFile(safe.absolute);
  }

  if (isProbablyBinary(buffer)) {
    return {
      path: safe.absolute,
      relative: safe.relative,
      size: st.size,
      lines: 0,
      language: "binary",
      imports: [],
      exports: [],
      symbols: [],
      sections: [],
      head: [],
      tail: [],
      truncated,
    };
  }

  const text = buffer.toString("utf8");
  const allLines = text.split(/\r?\n/);
  const lines = allLines.length;
  const lang = detectLanguage(safe.relative);

  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: Array<{ kind: string; name: string; line: number }> = [];

  const impRe = IMPORT_PATTERNS[lang];
  const expRe = EXPORT_PATTERNS[lang];
  const symRes = SYMBOL_PATTERNS[lang] ?? [];

  const seenSymbols = new Set<string>();
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (impRe) {
      const m = line.match(impRe);
      if (m) {
        const val = (m[1] ?? m[2] ?? "").trim();
        if (val && imports.length < 40) imports.push(val.replace(/[{}]/g, "").trim());
      }
    }
    if (expRe) {
      const m = line.match(expRe);
      if (m && m[1]) {
        const name = m[1].trim();
        if (name && !exports.includes(name) && exports.length < 40) exports.push(name);
      }
    }
    for (const { kind, re } of symRes) {
      const m = line.match(re);
      if (m && m[1]) {
        const name = m[1].trim();
        const key = kind + ":" + name;
        if (!seenSymbols.has(key) && symbols.length < 80) {
          seenSymbols.add(key);
          symbols.push({ kind, name, line: i + 1 });
        }
      }
    }
  }

  // Markdown sections
  const sections: string[] = [];
  if (lang === "md") {
    for (const line of allLines) {
      const m = line.match(/^(#{1,6})\s+(.+)/);
      if (m) sections.push(m[2].trim());
    }
  }

  const head = allLines.slice(0, 5).map((l) => l.slice(0, 120));
  const tail = allLines.length > 5 ? allLines.slice(-3).map((l) => l.slice(0, 120)) : [];

  return {
    path: safe.absolute,
    relative: safe.relative,
    size: st.size,
    lines,
    language: lang,
    imports: [...new Set(imports)].slice(0, 40),
    exports: [...new Set(exports)].slice(0, 40),
    symbols: symbols.slice(0, 80),
    sections: sections.slice(0, 60),
    head,
    tail,
    truncated,
  };
}

export function renderFileSummary(s: FileSummary): string {
  const lines: string[] = [];
  lines.push(`<b>📄 ${esc(s.relative)}</b>  (${formatBytes(s.size)} · ${s.lines} líneas · ${esc(s.language)})`);
  if (s.truncated) lines.push("<i>Archivo truncado para el resumen.</i>");
  if (s.language === "binary") {
    lines.push("Archivo binario. Usa /file para descargarlo.");
    return lines.join("\n");
  }
  if (s.imports.length) {
    lines.push("");
    lines.push(`<b>Imports (${s.imports.length}):</b>`);
    lines.push(s.imports.slice(0, 15).map((x) => `  • ${esc(x)}`).join("\n"));
    if (s.imports.length > 15) lines.push(`  … y ${s.imports.length - 15} más`);
  }
  if (s.exports.length) {
    lines.push("");
    lines.push(`<b>Exports (${s.exports.length}):</b> ${s.exports.slice(0, 20).map(esc).join(", ")}${s.exports.length > 20 ? "…" : ""}`);
  }
  if (s.sections.length) {
    lines.push("");
    lines.push(`<b>Secciones (${s.sections.length}):</b>`);
    for (const sec of s.sections.slice(0, 30)) lines.push(`  • ${esc(sec)}`);
    if (s.sections.length > 30) lines.push(`  … y ${s.sections.length - 30} más`);
  }
  if (s.symbols.length) {
    lines.push("");
    lines.push(`<b>Símbolos (${s.symbols.length}):</b>`);
    for (const sym of s.symbols.slice(0, 40)) {
      lines.push(`  ${esc(sym.kind)} ${esc(sym.name)}  <i>L${sym.line}</i>`);
    }
    if (s.symbols.length > 40) lines.push(`  … y ${s.symbols.length - 40} más`);
  }
  if (s.head.length && !s.symbols.length && !s.sections.length) {
    lines.push("");
    lines.push("<b>Primeras líneas:</b>");
    lines.push(s.head.map((l) => esc(l)).join("\n"));
  }
  if (s.tail.length && s.lines > 8) {
    lines.push("");
    lines.push("<b>Últimas líneas:</b>");
    lines.push(s.tail.map((l) => esc(l)).join("\n"));
  }
  return lines.join("\n");
}


export type FileDocument = {
  absolute: string;
  relative: string;
  name: string;
  size: number;
};

export type FileErrorCode =
  | "invalid"
  | "not_found"
  | "outside"
  | "not_file"
  | "not_directory"
  | "too_large"
  | "binary";

export class FileAccessError extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileAccessError";
    this.code = code;
  }
}

export const MAX_DOCUMENT_BYTES = 45 * 1024 * 1024;
export const MAX_READ_BYTES = 160 * 1024;

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  ".cache",
  ".next",
  ".zig-cache",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "zig-cache",
]);

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Resolve a Telegram-supplied path and ensure the real target stays inside the
 * session directory. Absolute paths are accepted only when they are inside.
 */
export async function resolveSafePath(base: string, input = ""): Promise<SafePath> {
  if (input.includes("\0")) throw new FileAccessError("invalid", "Invalid path.");

  let baseReal: string;
  try {
    baseReal = await realpath(base);
  } catch {
    throw new FileAccessError("not_found", `Directory not found: ${base}`);
  }

  const cleaned = input.trim() || ".";
  const candidate = isAbsolute(cleaned) ? resolve(cleaned) : resolve(baseReal, cleaned);

  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch {
    throw new FileAccessError("not_found", `Path not found: ${input.trim() || "."}`);
  }

  if (!isInside(baseReal, targetReal)) {
    throw new FileAccessError("outside", "Path is outside the session directory.");
  }

  return {
    base: baseReal,
    absolute: targetReal,
    relative: toPosix(relative(baseReal, targetReal)),
  };
}

export async function listDirectory(base: string, input = "", options: { includeHidden?: boolean; maxEntries?: number } = {}): Promise<DirListing> {
  const includeHidden = options.includeHidden ?? false;
  const maxEntries = Math.max(1, options.maxEntries ?? 500);
  const safe = await resolveSafePath(base, input);

  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input.trim() || "."}`);
  if (!st.isDirectory()) throw new FileAccessError("not_directory", "That path is not a directory.");

  let dirents;
  try {
    dirents = await readdir(safe.absolute, { withFileTypes: true });
  } catch {
    throw new FileAccessError("not_found", `Could not read directory: ${input.trim() || "."}`);
  }

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (!includeHidden && dirent.name.startsWith(".")) continue;

    const absolute = join(safe.absolute, dirent.name);
    const entryPath = toPosix(relative(safe.base, absolute));
    const entry: FileEntry = {
      name: dirent.name,
      path: entryPath,
      type: "file",
      size: 0,
      mtime: 0,
      symlink: false,
      external: false,
    };

    try {
      const lst = await lstat(absolute);
      entry.mtime = lst.mtimeMs;
      entry.symlink = lst.isSymbolicLink();

      if (lst.isSymbolicLink()) {
        try {
          const real = await realpath(absolute);
          if (!isInside(safe.base, real)) {
            entry.type = "symlink";
            entry.external = true;
          } else {
            const rst = await stat(real);
            if (rst.isDirectory()) entry.type = "directory";
            else if (rst.isFile()) {
              entry.type = "file";
              entry.size = rst.size;
            } else {
              entry.type = "symlink";
            }
          }
        } catch {
          entry.type = "symlink";
          entry.external = true;
        }
      } else if (lst.isDirectory()) {
        entry.type = "directory";
      } else if (lst.isFile()) {
        entry.type = "file";
        entry.size = lst.size;
      } else {
        continue;
      }
    } catch {
      entry.type = "symlink";
      entry.external = true;
    }

    entries.push(entry);
  }

  entries.sort(compareEntries);
  const total = entries.length;
  return {
    base: safe.base,
    path: safe.relative,
    absolute: safe.absolute,
    entries: entries.slice(0, maxEntries),
    total,
    truncated: total > maxEntries,
  };
}

export async function findFiles(
  base: string,
  query: string,
  options: {
    type?: "file" | "directory";
    limit?: number;
    maxScan?: number;
    maxDepth?: number;
    includeHidden?: boolean;
    skipDirs?: Iterable<string>;
  } = {},
): Promise<FindResult> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) throw new FileAccessError("invalid", "Search query is empty.");

  const limit = Math.max(1, options.limit ?? 30);
  const maxScan = Math.max(1, options.maxScan ?? 50_000);
  const maxDepth = Math.max(0, options.maxDepth ?? 12);
  const includeHidden = options.includeHidden ?? false;
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(options.skipDirs ?? [])]);

  const safe = await resolveSafePath(base, ".");
  const st = await stat(safe.absolute).catch(() => null);
  if (!st?.isDirectory()) throw new FileAccessError("not_directory", "Session directory is not available.");

  const entries: FileEntry[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
  let scanned = 0;
  let truncated = false;

  while (stack.length) {
    if (entries.length >= limit || scanned >= maxScan) {
      truncated = true;
      break;
    }

    const current = stack.pop()!;
    const absoluteDir = current.path ? join(safe.base, current.path) : safe.base;
    let dirents;
    try {
      dirents = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    for (const dirent of dirents) {
      if (entries.length >= limit || scanned >= maxScan) {
        truncated = true;
        break;
      }

      if (!includeHidden && dirent.name.startsWith(".")) continue;
      if (dirent.isSymbolicLink()) continue;

      scanned++;
      const absolute = join(absoluteDir, dirent.name);
      const entryPath = toPosix(relative(safe.base, absolute));
      const matches = entryPath.toLowerCase().includes(normalized);

      if (dirent.isDirectory()) {
        if (current.depth < maxDepth && !skipDirs.has(dirent.name)) {
          stack.push({ path: entryPath, depth: current.depth + 1 });
        }
        if (matches && (options.type ?? "directory") === "directory") {
          const entry = await makeEntry(absolute, entryPath, "directory");
          if (entry) entries.push(entry);
        }
      } else if (dirent.isFile()) {
        if (matches && (options.type ?? "file") === "file") {
          const entry = await makeEntry(absolute, entryPath, "file");
          if (entry) entries.push(entry);
        }
      }
    }
  }

  // The walk is depth-first; show a stable, alphabetical result list.
  entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  return { base: safe.base, entries, scanned, truncated };
}

async function makeEntry(absolute: string, entryPath: string, type: "file" | "directory"): Promise<FileEntry | null> {
  try {
    const st = await stat(absolute);
    return {
      name: basename(absolute),
      path: entryPath,
      type,
      size: type === "file" ? st.size : 0,
      mtime: st.mtimeMs,
      symlink: false,
      external: false,
    };
  } catch {
    return null;
  }
}

export async function readTextFile(
  base: string,
  input: string,
  options: { startLine?: number; maxLines?: number; maxBytes?: number } = {},
): Promise<ReadResult> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isFile()) throw new FileAccessError("not_file", "That path is not a file.");

  const maxBytes = Math.max(1, options.maxBytes ?? MAX_READ_BYTES);
  const byteTruncated = st.size > maxBytes;
  let buffer: Buffer;

  if (byteTruncated) {
    const handle = await open(safe.absolute, "r");
    try {
      const chunk = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(chunk, 0, maxBytes, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    buffer = await readFile(safe.absolute);
  }

  if (isProbablyBinary(buffer)) {
    throw new FileAccessError("binary", "Binary file; use /file to download it.");
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  const totalLines = byteTruncated ? undefined : lines.length;
  const requestedStart = Math.max(1, Math.floor(options.startLine ?? 1));
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? 200));
  const startIndex = Math.min(requestedStart - 1, lines.length);
  const endIndex = Math.min(lines.length, startIndex + maxLines);
  const text = lines.slice(startIndex, endIndex).join("\n");
  const lineTruncated = endIndex < lines.length || startIndex > 0;

  return {
    base: safe.base,
    absolute: safe.absolute,
    relative: safe.relative,
    size: st.size,
    text,
    startLine: startIndex + 1,
    endLine: endIndex,
    totalLines,
    truncated: byteTruncated || lineTruncated,
  };
}

export async function searchTextFile(
  base: string,
  input: string,
  pattern: string,
  options: { caseSensitive?: boolean; maxMatches?: number; contextLines?: number } = {},
): Promise<SearchResult> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isFile()) throw new FileAccessError("not_file", "That path is not a file.");

  const maxBytes = 2 * 1024 * 1024;
  let buffer: Buffer;
  const truncatedSize = st.size > maxBytes;
  if (truncatedSize) {
    const handle = await open(safe.absolute, "r");
    try {
      const chunk = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(chunk, 0, maxBytes, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    buffer = await readFile(safe.absolute);
  }

  if (isProbablyBinary(buffer)) {
    throw new FileAccessError("binary", "Binary file; use /file to download it.");
  }

  const caseSensitive = options.caseSensitive ?? false;
  const maxMatches = Math.max(1, options.maxMatches ?? 60);
  const lines = buffer.toString("utf8").split(/\r?\n/);

  let re: RegExp;
  const trimmed = pattern.trim();
  const slashMatch = trimmed.match(/^\/(.+)\/(i)?$/);
  if (slashMatch) {
    try {
      re = new RegExp(slashMatch[1], slashMatch[2] ? "i" : (caseSensitive ? "" : "i"));
    } catch {
      // Fall back to literal if regex is invalid.
      re = new RegExp(escapeRegExp(trimmed), caseSensitive ? "" : "i");
    }
  } else {
    re = new RegExp(escapeRegExp(trimmed), caseSensitive ? "" : "i");
  }

  const matches: SearchMatch[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      total++;
      if (matches.length < maxMatches) matches.push({ line: i + 1, text: lines[i].slice(0, 300) });
      re.lastIndex = 0;
    }
  }

  return {
    base: safe.base,
    absolute: safe.absolute,
    relative: safe.relative,
    size: st.size,
    pattern: trimmed,
    matches,
    totalMatches: total,
    truncated: truncatedSize || total > maxMatches,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export async function prepareDocument(base: string, input: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<FileDocument> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isFile()) throw new FileAccessError("not_file", "That path is not a file.");
  if (st.size > maxBytes) {
    throw new FileAccessError("too_large", `File too large (${formatBytes(st.size)}; limit ${formatBytes(maxBytes)}).`);
  }
  return {
    absolute: safe.absolute,
    relative: safe.relative,
    name: basename(safe.absolute),
    size: st.size,
  };
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32) control++;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

export type ArchiveResult = {
  absolute: string;
  name: string;
  size: number;
  cleanup: () => Promise<void>;
};

export async function createZipArchive(
  base: string,
  input = ".",
  maxBytes = MAX_DOCUMENT_BYTES,
): Promise<ArchiveResult> {
  const safe = await resolveSafePath(base, input || ".");
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isDirectory() && !st.isFile()) {
    throw new FileAccessError("invalid", "That path cannot be archived.");
  }

  const tmpDir = await mkdtemp(join("/tmp/opencode", "zip-"));
  const archiveName = `${basename(safe.absolute) || "archive"}.zip`;
  const archivePath = join(tmpDir, archiveName);
  const target = safe.relative || ".";

  try {
    await execFileAsync(
      "zip",
      ["-r", "-y", "-q", archivePath, target, "-x", "*/node_modules/*", "*/.git/*", "*/dist/*", "*/.cache/*", "*/coverage/*"],
      { cwd: safe.base },
    );
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new FileAccessError("invalid", `Could not create archive: ${message}`);
  }

  const archiveStat = await stat(archivePath).catch(() => null);
  if (!archiveStat) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new FileAccessError("not_found", "Archive was not created.");
  }
  if (archiveStat.size > maxBytes) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new FileAccessError("too_large", `Archive too large (${formatBytes(archiveStat.size)}; limit ${formatBytes(maxBytes)}).`);
  }

  return {
    absolute: archivePath,
    name: archiveName,
    size: archiveStat.size,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function fileErrorMessage(err: unknown): string {
  if (err instanceof FileAccessError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const rank = (entry: FileEntry) => (entry.type === "directory" ? 0 : entry.type === "file" ? 1 : 2);
  const byType = rank(a) - rank(b);
  if (byType !== 0) return byType;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
