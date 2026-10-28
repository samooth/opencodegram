import { OpenCode } from "@opencode/client";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveServerPassword(): string | undefined {
  if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD;
  try {
    const raw = readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8");
    const parsed = JSON.parse(raw) as { password?: string };
    return parsed.password;
  } catch {
    return undefined;
  }
}

export class OpenCodeBridge {
  readonly client;

  constructor(baseUrl: string, password?: string, username = "opencode") {
    const headers: Record<string, string> = {};
    if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    this.client = OpenCode.make({ baseUrl, headers } as any);
  }

  async serverInfo() {
    return this.client.server.info();
  }

  async listSessions() {
    return this.client.session.list();
  }

  async createSession(opts: { title?: string; directory?: string; model?: { id: string; providerID: string; variant?: string }; agent?: string } = {}) {
    return this.client.session.create({
      title: opts.title,
      location: opts.directory ? { directory: opts.directory } : undefined,
      model: opts.model ?? undefined,
      agent: opts.agent ?? undefined,
    });
  }

  async latestSessionDirectory(): Promise<string | undefined> {
    try {
      const res = await this.client.session.list();
      const sessions = (res as any)?.data ?? (Array.isArray(res) ? res : []);
      const sorted = [...sessions].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0));
      return sorted[0]?.location?.directory ?? sorted[0]?.directory;
    } catch {
      return undefined;
    }
  }

  async defaultModel(directory?: string) {
    try {
      const res = await this.client.model.default(directory ? { location: { directory } } : undefined);
      const data = (res as any)?.data ?? res;
      if (data?.id && data?.providerID) {
        return { id: data.id, providerID: data.providerID, variant: data.variants?.find((v: any) => v.id === "max")?.id };
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async prompt(sessionId: string, text: string) {
    return this.client.session.prompt({ sessionID: sessionId, text });
  }

  async interrupt(sessionId: string) {
    return this.client.session.interrupt({ sessionID: sessionId });
  }

  async replyPermission(sessionId: string, requestId: string, decision: "once" | "always" | "reject") {
    return this.client.permission.reply({ sessionID: sessionId, requestID: requestId, decision });
  }

  events() {
    return this.client.event.subscribe();
  }
}