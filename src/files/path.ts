import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
