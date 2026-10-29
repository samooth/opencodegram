export function isEditTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "edit" || normalized.includes("edit") || normalized === "apply_patch" || normalized.includes("patch") || normalized === "write";
}

export function extractEditFile(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as { filePath?: unknown; file?: unknown; path?: unknown; filename?: unknown };
    const value = parsed.filePath ?? parsed.file ?? parsed.path ?? parsed.filename;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function formatEditDiff(input: string | undefined): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as { filePath?: unknown; file?: unknown; path?: unknown; oldString?: unknown; old_string?: unknown; newString?: unknown; new_string?: unknown };
    const filePath = typeof parsed.filePath === "string" ? parsed.filePath : typeof parsed.file === "string" ? parsed.file : typeof parsed.path === "string" ? parsed.path : "file";
    const oldString = typeof parsed.oldString === "string" ? parsed.oldString : typeof parsed.old_string === "string" ? parsed.old_string : "";
    const newString = typeof parsed.newString === "string" ? parsed.newString : typeof parsed.new_string === "string" ? parsed.new_string : "";
    const lines = [`--- ${filePath}`, `+++ ${filePath}`];
    for (const line of oldString.split("\n")) lines.push(`- ${line}`);
    for (const line of newString.split("\n")) lines.push(`+ ${line}`);
    return lines.join("\n");
  } catch {
    return input;
  }
}
