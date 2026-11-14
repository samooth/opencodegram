import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import {
  resolveSafePath,
  FileAccessError,
} from "./path.js";

export async function treeDirectory(base: string, input = "", maxDepth = 3): Promise<{ base: string; relative: string; lines: string[] }> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isDirectory()) throw new FileAccessError("not_directory", "That path is not a directory.");

  const lines: string[] = [];
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    const filtered = entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (let i = 0; i < filtered.length; i++) {
      const e = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && depth < maxDepth) {
        await walk(join(dir, e.name), prefix + childPrefix, depth + 1);
      }
    }
  }
  lines.push(safe.relative || ".");
  await walk(safe.absolute, "", 1);
  return { base: safe.base, relative: safe.relative, lines };
}
