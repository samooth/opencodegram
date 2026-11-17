import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

/**
 * Small persistence helpers shared by the JSON state files.
 *
 * Every save writes to a temporary file in the same directory and renames it
 * over the target. rename(2) is atomic on POSIX, so a crash mid-write leaves
 * the previous (valid) version in place instead of a truncated JSON file.
 */

let tmpSeq = 0;

export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown, pretty = true): void {
  writeFileAtomic(file, JSON.stringify(value, null, pretty ? 2 : 0));
}

/**
 * Read and parse a JSON file. When the contents are corrupt the file is moved
 * aside to `<file>.corrupt` (so it is not silently overwritten by the next
 * save) and `undefined` is returned, letting the caller fall back to defaults.
 */
export function readJsonSafe<T>(file: string, tag: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    const backup = `${file}.corrupt`;
    try {
      renameSync(file, backup);
      logger.error(tag, `corrupt JSON moved to ${backup}`, err);
    } catch (renameErr) {
      logger.error(tag, "load failed", err, renameErr);
    }
    return undefined;
  }
}
