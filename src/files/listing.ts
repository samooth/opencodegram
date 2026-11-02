import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  resolveSafePath,
  isInside,
  toPosix,
  type FileEntry,
  type DirListing,
  type FindResult,
  FileAccessError,
} from "./path.js";

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

function compareEntries(a: FileEntry, b: FileEntry): number {
  const rank = (entry: FileEntry) => (entry.type === "directory" ? 0 : entry.type === "file" ? 1 : 2);
  const byType = rank(a) - rank(b);
  if (byType !== 0) return byType;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
