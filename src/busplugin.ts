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

/** Tool names emitted by the plugin when codemode is off. */
export function isBusToolName(name: string): boolean {
  return /^bus[_-]/i.test(name || "") || /^agentbus/i.test(name || "");
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
