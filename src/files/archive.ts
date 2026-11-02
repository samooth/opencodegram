import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import {
  resolveSafePath,
  FileAccessError,
  MAX_DOCUMENT_BYTES,
  formatBytes,
} from "./path.js";

const execFileAsync = promisify(execFile);

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

  await mkdir("/tmp/opencode", { recursive: true });
  const tmpDir = await mkdtemp(join("/tmp/opencode", "zip-"));
  const archiveName = `${basename(safe.absolute) || "archive"}.zip`;
  const archivePath = join(tmpDir, archiveName);
  const target = safe.relative || ".";
  const zipTarget = target === "." ? "." : `./${target}`;

  try {
    await execFileAsync(
      "zip",
      ["-r", "-y", "-q", archivePath, zipTarget, "-x", "*/node_modules/*", "*/.git/*", "*/dist/*", "*/.cache/*", "*/coverage/*"],
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
