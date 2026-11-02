import { open, readFile, stat } from "node:fs/promises";
import {
  resolveSafePath,
  FileAccessError,
} from "./path.js";
import { isProbablyBinary } from "./read.js";

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

  const trimmed = pattern.trim().slice(0, 500);
  let re: RegExp;
  const slashMatch = trimmed.match(/^\/(.+)\/(i)?$/);
  // Only honor an explicit regex when it is short enough to avoid ReDoS.
  if (slashMatch && slashMatch[1].length <= 30) {
    try {
      re = new RegExp(slashMatch[1], slashMatch[2] ? "i" : (caseSensitive ? "" : "i"));
    } catch {
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
