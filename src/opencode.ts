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

  async createSession(title?: string) {
    return this.client.session.create({ title });
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