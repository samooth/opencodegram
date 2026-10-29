export type DiffStyle = "simple" | "unified";

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

export function formatEditDiff(input: string | undefined, style: DiffStyle = "simple", baseDirectory?: string): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as { filePath?: unknown; file?: unknown; path?: unknown; oldString?: unknown; old_string?: unknown; newString?: unknown; new_string?: unknown };
    let filePath = typeof parsed.filePath === "string" ? parsed.filePath : typeof parsed.file === "string" ? parsed.file : typeof parsed.path === "string" ? parsed.path : "file";
    if (baseDirectory && filePath.startsWith(baseDirectory + "/")) filePath = filePath.slice(baseDirectory.length + 1);
    const oldString = typeof parsed.oldString === "string" ? parsed.oldString : typeof parsed.old_string === "string" ? parsed.old_string : "";
    const newString = typeof parsed.newString === "string" ? parsed.newString : typeof parsed.new_string === "string" ? parsed.new_string : "";
    if (style === "unified") return formatUnifiedDiff(filePath, oldString, newString);
    const lines = [`--- ${filePath}`, `+++ ${filePath}`];
    for (const line of oldString.split("\n")) lines.push(`- ${line}`);
    for (const line of newString.split("\n")) lines.push(`+ ${line}`);
    return lines.join("\n");
  } catch {
    return input ?? "";
  }
}

function formatUnifiedDiff(filePath: string, oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const lines = [`--- ${filePath}`, `+++ ${filePath}`, "@@ -1 +1 @@ "];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine === newLine) {
      lines.push(` ${oldLine ?? ""}`);
    } else {
      if (oldLine !== undefined) lines.push(`-${oldLine}`);
      if (newLine !== undefined) lines.push(`+${newLine}`);
    }
  }
  return lines.join("\n");
}
