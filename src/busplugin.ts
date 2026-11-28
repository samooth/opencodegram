/**
 * Native support for the `opencode-agentbus` plugin (samooth/opencode-agentbus).
 *
 * The plugin registers a `bus` tool namespace with codemode enabled, so its
 * calls reach the event stream either as `bus_<method>` tools or as `execute`
 * blocks running `tools.bus.<method>(...)`. This module detects the plugin and
 * parses its envelope so the card can show bus traffic on its own terms
 * instead of as generic tool calls.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: boolean | undefined;

/** True when opencode-agentbus is configured in the local OpenCode config. */
export function busPluginInstalled(): boolean {
  if (cached !== undefined) return cached;
  const files = [
    join(homedir(), ".config/opencode/cli.json"),
    join(homedir(), ".config/opencode/opencode.jsonc"),
    join(homedir(), ".config/opencode/opencode.json"),
  ];
  cached = files.some((file) => {
    try {
      return existsSync(file) && readFileSync(file, "utf8").includes("opencode-agentbus");
    } catch {
      return false;
    }
  });
  return cached;
}

/** Reset the cached detection (tests / config reload). */
export function resetBusPluginCache(): void {
  cached = undefined;
}

/** True for any text containing a tools.bus.<method>(...) call (even truncated). */
export function isBusCallText(text: string): boolean {
  return /tools\.bus\.\w+\s*\(/i.test(text || "");
}

/** Tool names emitted by the plugin when codemode is off. */
export function isBusToolName(name: string): boolean {
  return /^bus[_-]/i.test(name || "") || /^agentbus/i.test(name || "");
}

export type BusCall = { method: string; args: Record<string, string> };

const BUS_ARG_KEYS = ["from", "to", "type", "subject", "body", "replyTo", "supersedes", "alias", "role", "bus", "who", "sessionID", "limit"];

function argsFromObject(text: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const key of BUS_ARG_KEYS) {
    const m = text.match(new RegExp(`\\b${key}\\s*:\\s*(["'\`])([\\s\\S]*?)\\1`));
    if (m) args[key] = m[2];
  }
  return args;
}

/** Split a `const msgs = [ {...}, {...} ]` literal into its top-level objects. */
function objectLiterals(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/**
 * Parse every `tools.bus.<method>(...)` call in a code block. Handles both
 * inline object arguments and variables holding an array of messages, e.g.
 * `const msgs = [{ to: ..., type: ..., subject: ..., body: ... }]; tools.bus.send(msg)`.
 */
export function parseBusCalls(code: string): BusCall[] {
  if (!isBusCallText(code)) return [];
  const calls: BusCall[] = [];
  const seen = new Set<string>();
  const methodRe = /tools\.bus\.(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(code))) {
    const method = m[1].toLowerCase();
    const tail = code.slice(m.index + m[0].length);
    const inline = tail.match(/^\s*\{[\s\S]*?\}\s*\)/);
    if (inline) {
      const args = argsFromObject(inline[0]);
      const key = `${method}:${JSON.stringify(args)}`;
      if (!seen.has(key)) { seen.add(key); calls.push({ method, args }); }
      continue;
    }
    const variable = tail.match(/^\s*([A-Za-z_$][\w$]*)\s*\)/);
    if (!variable) continue;
    const name = variable[1];
    // `for (const msg of msgs)` sends an alias, not the declared array name.
    const alias = code.match(new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${name}\\s+of\\s+([\\w$]+)`));
    const sourceName = alias?.[1] ?? name;
    const def = code.match(new RegExp(`(?:const|let|var)\\s+${sourceName}\\s*=\\s*([\\s\\S]*?)(?:;|\\n\\s*(?:for|await|return|\\}|$))`));
    if (!def) continue;
    for (const obj of objectLiterals(def[1])) {
      const args = argsFromObject(obj);
      if (!Object.keys(args).length) continue;
      const key = `${method}:${JSON.stringify(args)}`;
      if (!seen.has(key)) { seen.add(key); calls.push({ method, args }); }
    }
  }
  return calls;
}

export type BusEnvelope = {
  from?: string;
  to?: string;
  id?: string;
  type?: string;
  replyTo?: string;
  supersedes?: string;
};

/** Parse `[FROM @x → TO @y | ID | TYPE | REPLY-TO | SUPERSEDES]`. */
export function parseBusEnvelope(text: string): BusEnvelope | null {
  const m = text.match(/\[FROM[^\]]*\]/i);
  if (!m) return null;
  const header = m[0];
  const grab = (re: RegExp): string | undefined => header.match(re)?.[1]?.trim();
  return {
    from: grab(/FROM\s+@?([^\s|\]]+)/i),
    to: grab(/TO\s+@?([^\s|\]]+)/i),
    id: grab(/ID\s+([^\s|\]]+)/i),
    type: grab(/TYPE\s+([^\s|\]]+)/i),
    replyTo: grab(/REPLY-TO\s+([^\s|\]]+)/i),
    supersedes: grab(/SUPERSEDES\s+([^\s|\]]+)/i),
  };
}
