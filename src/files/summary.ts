import { open, readFile, stat } from "node:fs/promises";
import { esc } from "../util.js";
import {
  resolveSafePath,
  formatBytes,
  FileAccessError,
} from "./path.js";
import { isProbablyBinary } from "./read.js";

export type FileSummary = {
  path: string;
  relative: string;
  size: number;
  lines: number;
  language: string;
  imports: string[];
  exports: string[];
  symbols: Array<{ kind: string; name: string; line: number }>;
  sections: string[];
  head: string[];
  tail: string[];
  truncated: boolean;
};

const SYMBOL_PATTERNS: Record<string, Array<{ kind: string; re: RegExp }>> = {
  ts: [
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+(\w+)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+(\w+)\s*=/ },
    { kind: "let", re: /^\s*(?:export\s+)?let\s+(\w+)/ },
  ],
  js: [
    { kind: "class", re: /^\s*(?:export\s+)?class\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+(\w+)\s*=/ },
  ],
  py: [
    { kind: "class", re: /^\s*class\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:async\s+)?def\s+(\w+)/ },
    { kind: "import", re: /^\s*(?:from\s+\S+\s+)?import\s+(.+)/ },
  ],
  go: [
    { kind: "struct", re: /^\s*type\s+(\w+)\s+struct/ },
    { kind: "interface", re: /^\s*type\s+(\w+)\s+interface/ },
    { kind: "function", re: /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/ },
    { kind: "const", re: /^\s*const\s+(\w+)/ },
    { kind: "var", re: /^\s*var\s+(\w+)/ },
  ],
  rs: [
    { kind: "struct", re: /^\s*(?:pub\s+)?struct\s+(\w+)/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?enum\s+(\w+)/ },
    { kind: "trait", re: /^\s*(?:pub\s+)?trait\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:pub\s+)?const\s+(\w+)/ },
    { kind: "mod", re: /^\s*(?:pub\s+)?mod\s+(\w+)/ },
  ],
  zig: [
    { kind: "struct", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*struct/ },
    { kind: "enum", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*enum/ },
    { kind: "union", re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*union/ },
    { kind: "function", re: /^\s*(?:pub\s+)?fn\s+(\w+)/ },
    { kind: "const", re: /^\s*(?:pub\s+)?const\s+(\w+)/ },
    { kind: "var", re: /^\s*(?:pub\s+)?var\s+(\w+)/ },
  ],
  c: [
    { kind: "struct", re: /^\s*(?:typedef\s+)?struct\s+(\w+)/ },
    { kind: "function", re: /^\s*(?:\w+[\s*]+)+?(\w+)\s*\([^)]*\)\s*\{/ },
    { kind: "define", re: /^\s*#define\s+(\w+)/ },
  ],
  java: [
    { kind: "class", re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/ },
    { kind: "interface", re: /^\s*(?:public\s+)?interface\s+(\w+)/ },
    { kind: "method", re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)+?(\w+)\s*\([^)]*\)\s*\{/ },
  ],
};

const IMPORT_PATTERNS: Record<string, RegExp> = {
  ts: /^\s*import\s+.+from\s+["']([^"']+)["']/,
  js: /^\s*import\s+.+from\s+["']([^"']+)["']/,
  py: /^\s*(?:from\s+(\S+)\s+import|import\s+(.+))/,
  go: /^\s*import\s+(?:\()?\s*["']([^"']+)["']/,
  rs: /^\s*use\s+([^;]+);/,
  zig: /^\s*const\s+\w+\s*=\s*@import\("([^"]+)"\)/,
  c: /^\s*#include\s+[<"]([^>"]+)[>"]/,
  java: /^\s*import\s+([^;]+);/,
};

const EXPORT_PATTERNS: Record<string, RegExp> = {
  ts: /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface|enum)\s+(\w+)/,
  js: /^\s*export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/,
  zig: /^\s*pub\s+(?:fn|const|var)\s+(\w+)/,
  rs: /^\s*pub\s+(?:fn|struct|enum|const|mod|trait)\s+(\w+)/,
  go: /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
};

function detectLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
    js: "js", jsx: "js", mjs: "js", cjs: "js",
    py: "py", pyi: "py",
    go: "go",
    rs: "rs",
    zig: "zig",
    c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c",
    java: "java",
    md: "md", markdown: "md",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  };
  return map[ext] ?? "text";
}

export async function summarizeFile(base: string, input: string): Promise<FileSummary> {
  const safe = await resolveSafePath(base, input);
  const st = await stat(safe.absolute).catch(() => null);
  if (!st) throw new FileAccessError("not_found", `Path not found: ${input || "."}`);
  if (!st.isFile()) throw new FileAccessError("not_file", "That path is not a file.");

  const MAX = 256 * 1024;
  const truncated = st.size > MAX;
  let buffer: Buffer;
  if (truncated) {
    const handle = await open(safe.absolute, "r");
    try {
      const chunk = Buffer.alloc(MAX);
      const { bytesRead } = await handle.read(chunk, 0, MAX, 0);
      buffer = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } else {
    buffer = await readFile(safe.absolute);
  }

  if (isProbablyBinary(buffer)) {
    return {
      path: safe.absolute,
      relative: safe.relative,
      size: st.size,
      lines: 0,
      language: "binary",
      imports: [],
      exports: [],
      symbols: [],
      sections: [],
      head: [],
      tail: [],
      truncated,
    };
  }

  const text = buffer.toString("utf8");
  const allLines = text.split(/\r?\n/);
  const lines = allLines.length;
  const lang = detectLanguage(safe.relative);

  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: Array<{ kind: string; name: string; line: number }> = [];

  const impRe = IMPORT_PATTERNS[lang];
  const expRe = EXPORT_PATTERNS[lang];
  const symRes = SYMBOL_PATTERNS[lang] ?? [];

  const seenSymbols = new Set<string>();
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (impRe) {
      const m = line.match(impRe);
      if (m) {
        const val = (m[1] ?? m[2] ?? "").trim();
        if (val && imports.length < 40) imports.push(val.replace(/[{}]/g, "").trim());
      }
    }
    if (expRe) {
      const m = line.match(expRe);
      if (m && m[1]) {
        const name = m[1].trim();
        if (name && !exports.includes(name) && exports.length < 40) exports.push(name);
      }
    }
    for (const { kind, re } of symRes) {
      const m = line.match(re);
      if (m && m[1]) {
        const name = m[1].trim();
        const key = kind + ":" + name;
        if (!seenSymbols.has(key) && symbols.length < 80) {
          seenSymbols.add(key);
          symbols.push({ kind, name, line: i + 1 });
        }
      }
    }
  }

  // Markdown sections
  const sections: string[] = [];
  if (lang === "md") {
    for (const line of allLines) {
      const m = line.match(/^(#{1,6})\s+(.+)/);
      if (m) sections.push(m[2].trim());
    }
  }

  const head = allLines.slice(0, 5).map((l) => l.slice(0, 120));
  const tail = allLines.length > 5 ? allLines.slice(-3).map((l) => l.slice(0, 120)) : [];

  return {
    path: safe.absolute,
    relative: safe.relative,
    size: st.size,
    lines,
    language: lang,
    imports: [...new Set(imports)].slice(0, 40),
    exports: [...new Set(exports)].slice(0, 40),
    symbols: symbols.slice(0, 80),
    sections: sections.slice(0, 60),
    head,
    tail,
    truncated,
  };
}

export function renderFileSummary(s: FileSummary): string {
  const lines: string[] = [];
  lines.push(`<b>📄 ${esc(s.relative)}</b>  (${formatBytes(s.size)} · ${s.lines} líneas · ${esc(s.language)})`);
  if (s.truncated) lines.push("<i>Archivo truncado para el resumen.</i>");
  if (s.language === "binary") {
    lines.push("Archivo binario. Usa /file para descargarlo.");
    return lines.join("\n");
  }

  const kindEmoji: Record<string, string> = {
    function: "ƒ", method: "ƒ", const: "κ", let: "λ", var: "ν",
    class: "C", interface: "I", type: "T", struct: "S", enum: "E",
    trait: "R", union: "U", mod: "M", define: "#",
  };

  if (s.imports.length) {
    lines.push("");
    const impRows = s.imports.slice(0, 15).map((x) => `• ${esc(x)}`).join("\n");
    const impMore = s.imports.length > 15 ? `\n… y ${s.imports.length - 15} más` : "";
    lines.push(`<blockquote><b>Imports (${s.imports.length})</b>\n${impRows}${impMore}</blockquote>`);
  }
  if (s.exports.length) {
    lines.push("");
    lines.push(`<blockquote><b>Exports (${s.exports.length})</b>\n${s.exports.slice(0, 20).map(esc).join(", ")}${s.exports.length > 20 ? "…" : ""}</blockquote>`);
  }
  if (s.sections.length) {
    lines.push("");
    const secRows = s.sections.slice(0, 30).map((sec) => `• ${esc(sec)}`).join("\n");
    const secMore = s.sections.length > 30 ? `\n… y ${s.sections.length - 30} más` : "";
    lines.push(`<blockquote><b>Secciones (${s.sections.length})</b>\n${secRows}${secMore}</blockquote>`);
  }
  if (s.symbols.length) {
    lines.push("");
    const maxName = Math.max(...s.symbols.map((x) => x.name.length), 4);
    const rows = s.symbols.slice(0, 50).map((sym) => {
      const em = kindEmoji[sym.kind] ?? "·";
      const name = sym.name.padEnd(maxName, " ");
      return `${em} ${name}  L${String(sym.line).padStart(3, " ")}`;
    });
    const symMore = s.symbols.length > 50 ? `\n… y ${s.symbols.length - 50} más` : "";
    lines.push(`<blockquote><b>Símbolos (${s.symbols.length})</b>\n<pre>${rows.map(esc).join("\n")}</pre>${symMore}</blockquote>`);
  }
  if (s.head.length && !s.symbols.length && !s.sections.length) {
    lines.push("");
    lines.push(`<blockquote><b>Primeras líneas</b>\n<pre>${s.head.map(esc).join("\n")}</pre></blockquote>`);
  }
  return lines.join("\n");
}
