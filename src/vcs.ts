import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";
import { FileAccessError } from "./files.js";

const execFileAsync = promisify(execFile);

export type VcsStatus = {
  branch: string;
  changed: number;
  files: string[];
  clean: boolean;
};

export type VcsActionResult = {
  ok: boolean;
  output: string;
};

async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: directory });
    return (stdout || stderr || "").trim();
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const message = (error.stderr || error.stdout || error.message || String(err)).trim();
    throw new Error(message || "git command failed");
  }
}

export async function vcsStatus(directory: string): Promise<VcsStatus> {
  const branchOutput = await runGit(directory, ["branch", "--show-current"]).catch(() => "");
  const branch = branchOutput || (await runGit(directory, ["rev-parse", "--short", "HEAD"]).catch(() => "HEAD"));
  const statusOutput = await runGit(directory, ["status", "--porcelain"]);
  const files = statusOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return { branch, changed: files.length, files, clean: files.length === 0 };
}

export async function vcsBranches(directory: string): Promise<string[]> {
  const output = await runGit(directory, ["branch", "-a", "--format=%(refname:short)"]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function vcsSwitch(directory: string, branch: string): Promise<VcsActionResult> {
  try {
    const output = await runGit(directory, ["switch", branch]);
    return { ok: true, output: output || `Switched to ${branch}` };
  } catch (err) {
    // Older Git versions use checkout.
    const output = await runGit(directory, ["checkout", branch]);
    return { ok: true, output: output || `Switched to ${branch}` };
  }
}

export async function vcsStage(directory: string, path: string): Promise<VcsActionResult> {
  const safePath = await safeRelativePath(directory, path);
  const output = await runGit(directory, ["add", "--", safePath]);
  return { ok: true, output: output || `Staged ${safePath}` };
}

export async function vcsUnstage(directory: string, path: string): Promise<VcsActionResult> {
  const safePath = await safeRelativePath(directory, path);
  const output = await runGit(directory, ["reset", "HEAD", "--", safePath]);
  return { ok: true, output: output || `Unstaged ${safePath}` };
}

export async function vcsCommit(directory: string, message: string): Promise<VcsActionResult> {
  const output = await runGit(directory, ["commit", "-m", message]);
  return { ok: true, output: output || "Committed" };
}

export async function vcsDiff(directory: string, cached = false, path?: string): Promise<string> {
  const args = cached ? ["diff", "--cached"] : ["diff"];
  if (path) {
    const safePath = await safeRelativePath(directory, path);
    args.push("--", safePath);
  }
  return runGit(directory, args);
}

export async function vcsLog(directory: string, limit = 10): Promise<string> {
  return runGit(directory, ["log", "--oneline", `-${limit}`]);
}

async function safeRelativePath(directory: string, path: string): Promise<string> {
  const base = resolve(directory);
  const target = resolve(base, path);
  const relativePath = relative(base, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new FileAccessError("outside", "Path is outside the session directory.");
  }
  return relativePath;
}
