export type DiffStyle = "simple" | "unified";

export function isEditTool(name: string, input?: string): boolean {
  const normalized = name.toLowerCase();
  if (
    normalized === "edit" ||
    normalized.includes("edit") ||
    normalized === "apply_patch" ||
    normalized.includes("patch") ||
    normalized === "write" ||
    normalized.includes("write") ||
    normalized === "multiedit" ||
    normalized.includes("multiedit")
  ) {
    return true;
  }
  if (input && (/"old[Ss]tring"/.test(input) || /"new[Ss]tring"/.test(input) || /"old_string"/.test(input) || /"new_string"/.test(input) || /"oldText"/.test(input) || /"newText"/.test(input))) {
    return true;
  }
  return false;
}

export function extractEditFile(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of ["filePath", "file", "path", "filename", "target"]) {
      if (typeof parsed[key] === "string" && (parsed[key] as string).trim()) return (parsed[key] as string).trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function formatEditDiff(input: string | undefined, style: DiffStyle = "simple", baseDirectory?: string): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    let filePath = "file";
    for (const key of ["filePath", "file", "path", "filename", "target"]) {
      if (typeof parsed[key] === "string" && (parsed[key] as string).trim()) { filePath = (parsed[key] as string).trim(); break; }
    }
    if (baseDirectory && filePath.startsWith(baseDirectory + "/")) filePath = filePath.slice(baseDirectory.length + 1);

    const oldKeys = ["oldString", "old_string", "oldText", "old_text", "old", "original", "before"];
    const newKeys = ["newString", "new_string", "newText", "new_text", "new", "updated", "after"];
    let oldString = "";
    let newString = "";
    for (const k of oldKeys) if (typeof parsed[k] === "string") { oldString = parsed[k] as string; break; }
    for (const k of newKeys) if (typeof parsed[k] === "string") { newString = parsed[k] as string; break; }

    if (!oldString && !newString && Array.isArray(parsed.changes)) {
      const parts: string[] = [];
      for (const c of parsed.changes as Array<Record<string, unknown>>) {
        const f = typeof c.path === "string" ? c.path : typeof c.file === "string" ? c.file : filePath;
        const o = typeof c.old === "string" ? c.old : typeof c.oldString === "string" ? c.oldString : typeof c.old_string === "string" ? c.old_string : typeof c.oldText === "string" ? c.oldText : "";
        const n = typeof c.new === "string" ? c.new : typeof c.newString === "string" ? c.newString : typeof c.new_string === "string" ? c.new_string : typeof c.newText === "string" ? c.newText : "";
        parts.push(`--- ${f}`);
        parts.push(`+++ ${f}`);
        for (const line of o.split("\n")) parts.push(`- ${line}`);
        for (const line of n.split("\n")) parts.push(`+ ${line}`);
      }
      if (parts.length) return parts.join("\n");
    }

    if (!oldString && !newString) {
      // Never return an empty diff: show the raw input so the user sees something.
      return input ?? "";
    }
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
