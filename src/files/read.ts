import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  resolveSafePath,
  FileAccessError,
  MAX_READ_BYTES,
  MAX_DOCUMENT_BYTES,
  formatBytes,
  type ReadResult,
  type FileDocument,
} from "./path.js";

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
