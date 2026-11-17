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

export type ToolTarget = { file: string; hint: string };

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Extract a readable file target and detail (line range or search pattern)
 * from a tool's raw JSON input, an apply_patch blob, or a plain path. */
export function describeToolInput(input: string | undefined): ToolTarget {
  if (!input || !input.trim()) return { file: "", hint: "" };
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const file = firstString(obj, ["filePath", "file_path", "file", "path", "filename", "target"]) ?? "";
        const pattern = firstString(obj, ["pattern", "query", "regex", "term", "search"]) ?? "";
        const start = firstNumber(obj, ["offset", "start", "startLine", "line", "row", "from"]);
        const limit = firstNumber(obj, ["limit", "count"]);
        const end = firstNumber(obj, ["end", "endLine", "to"]);
        let hint = pattern;
        if (!hint) {
          if (start !== undefined && limit !== undefined) hint = `${start}-${start + limit - 1}`;
          else if (start !== undefined && end !== undefined) hint = `${start}-${end}`;
          else if (start !== undefined) hint = String(start);
        }
        return { file, hint };
      }
    } catch {
      // Not JSON; fall through to the other formats.
    }
  }
  const patch = trimmed.match(/\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)/);
  if (patch) return { file: patch[1].trim(), hint: "" };
  return { file: trimmed.split(/\s+/)[0] ?? trimmed, hint: "" };
}

export function extractEditFile(input: string | undefined): string | null {
  if (!input) return null;
  // Try JSON first.
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of ["filePath", "file_path", "file", "path", "filename", "target"]) {
      if (typeof parsed[key] === "string" && (parsed[key] as string).trim()) return (parsed[key] as string).trim();
    }
  } catch {
    // Not JSON: maybe an apply_patch text blob.
  }
  // apply_patch format: "*** Update File: path" or "*** Add File: path".
  const m = input.match(/\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)/);
  if (m) return m[1].trim();
  return null;
}

export function editStats(input: string | undefined): { file: string; added: number; removed: number } {
  const file = extractEditFile(input) ?? "edit";
  const diff = formatEditDiff(input, "simple");
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { file, added, removed };
}

/**
 * Parse an OpenCode apply_patch blob into a list of file diffs.
 * Format:
 *   *** Begin Patch
 *   *** Update File: path/to/file
 *   @@ context line
 *   -old line
 *   +new line
 *   *** End Patch
 */
function parseApplyPatch(input: string): Array<{ file: string; oldLines: string[]; newLines: string[] }> | null {
  if (!/\*\*\*\s*Begin Patch/i.test(input) && !/\*\*\*\s*(Update|Add|Delete)\s+File:/i.test(input)) return null;
  const results: Array<{ file: string; oldLines: string[]; newLines: string[] }> = [];
  const lines = input.split(/\r?\n/);
  let currentFile: string | null = null;
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flush = () => {
    if (currentFile) {
      results.push({ file: currentFile, oldLines, newLines });
      oldLines = [];
      newLines = [];
    }
  };
  for (const line of lines) {
    const fm = line.match(/\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)/i);
    if (fm) {
      flush();
      currentFile = fm[1].trim();
      continue;
    }
    if (/^\*\*\*\s*End Patch/i.test(line) || /^\*\*\*\s*Begin Patch/i.test(line)) {
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      // context line belongs to both
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  flush();
  return results.length ? results : null;
}

export function formatEditDiff(input: string | undefined, style: DiffStyle = "simple", baseDirectory?: string): string {
  if (!input) return "";
  // apply_patch format (text blob, not JSON).
  const patches = parseApplyPatch(input);
  if (patches) {
    const parts: string[] = [];
    for (const p of patches) {
      let filePath = p.file;
      if (baseDirectory && filePath.startsWith(baseDirectory + "/")) filePath = filePath.slice(baseDirectory.length + 1);
      if (style === "unified") {
        parts.push(formatUnifiedDiff(filePath, p.oldLines.join("\n"), p.newLines.join("\n")));
      } else {
        parts.push(`--- ${filePath}`);
        parts.push(`+++ ${filePath}`);
        for (const l of p.oldLines) parts.push(`- ${l}`);
        for (const l of p.newLines) parts.push(`+ ${l}`);
      }
    }
    return parts.join("\n");
  }
  // JSON format.
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    let filePath = "file";
    for (const key of ["filePath", "file_path", "file", "path", "filename", "target"]) {
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
        parts.push(formatEditDiff(JSON.stringify({ filePath: f, oldString: o, newString: n }), style, baseDirectory));
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

/**
 * Real unified diff with 3 lines of context, computed via LCS.
 */
function formatUnifiedDiff(filePath: string, oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const CONTEXT = 3;

  // Compute LCS table.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to get the edit script.
  type Op = { type: "eq" | "del" | "ins"; oldIdx: number; newIdx: number };
  const ops: Op[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: "eq", oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: "ins", oldIdx: i, newIdx: j - 1 });
      j--;
    } else {
      ops.unshift({ type: "del", oldIdx: i - 1, newIdx: j });
      i--;
    }
  }

  // Group into hunks with context.
  const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
  let current: { oldStart: number; newStart: number; lines: string[] } | null = null;
  let oldLineNo = 1;
  let newLineNo = 1;
  // First pass: mark which ops are "changed" (del/ins) and include context.
  const changed = ops.map((o) => o.type !== "eq");
  // Expand context around changed ops.
  const include = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (changed[k]) {
      for (let c = Math.max(0, k - CONTEXT); c <= Math.min(ops.length - 1, k + CONTEXT); c++) {
        include[c] = true;
      }
    }
  }
  // Build hunks: consecutive included ops, with gaps collapsed.
  let hunkStart = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!include[k]) {
      if (current) { hunks.push(current); current = null; }
      continue;
    }
    const op = ops[k];
    if (!current) {
      // compute start line numbers
      const oldStart = op.type === "ins" ? oldLineNo : op.oldIdx + 1;
      const newStart = op.type === "del" ? newLineNo : op.newIdx + 1;
      current = { oldStart, newStart, lines: [] };
    }
    if (op.type === "eq") {
      current.lines.push(` ${op.oldIdx >= 0 ? oldLines[op.oldIdx] : ""}`);
    } else if (op.type === "del") {
      current.lines.push(`-${oldLines[op.oldIdx]}`);
    } else {
      current.lines.push(`+${newLines[op.newIdx]}`);
    }
    // update line counters
    if (op.type !== "ins") oldLineNo++;
    if (op.type !== "del") newLineNo++;
  }
  if (current) hunks.push(current);

  if (hunks.length === 0) {
    // No changes.
    return `--- ${filePath}\n+++ ${filePath}`;
  }

  const out: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const h of hunks) {
    const oldCount = h.lines.filter((l) => !l.startsWith("+")).length;
    const newCount = h.lines.filter((l) => !l.startsWith("-")).length;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
    out.push(...h.lines);
  }
  return out.join("\n");
}
