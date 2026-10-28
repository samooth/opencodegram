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

  async listCommands(directory?: string) {
    try {
      const res = await this.client.command.list(directory ? { location: { directory } } as any : undefined);
      return (res as any)?.data ?? (Array.isArray(res) ? res : []);
    } catch {
      return [];
    }
  }

  async runCommand(sessionId: string, name: string, args: string) {
    return this.client.session.command({ sessionID: sessionId, name, text: args });
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

  async prompt(sessionId: string, text: string, files?: Array<{ uri: string; name?: string }>) {
    return this.client.session.prompt({ sessionID: sessionId, text, files });
  }

  async switchModel(sessionId: string, model: { id: string; providerID: string; variant?: string }) {
    return this.client.session.switchModel({ sessionID: sessionId, model });
  }

  async switchAgent(sessionId: string, agent: string) {
    return this.client.session.switchAgent({ sessionID: sessionId, agent });
  }

  async listAgents(directory?: string) {
    const res = await this.client.agent.list(directory ? { location: { directory } } as any : undefined);
    return (res as any)?.data ?? (Array.isArray(res) ? res : []);
  }

  async forkSession(sessionId: string) {
    return this.client.session.fork({ sessionID: sessionId });
  }

  async renameSession(sessionId: string, title: string) {
    return this.client.session.update({ sessionID: sessionId, title });
  }

  async archiveSession(sessionId: string, archived: boolean) {
    return this.client.session.update({ sessionID: sessionId, archived });
  }

  async deleteSession(sessionId: string) {
    return this.client.session.remove({ sessionID: sessionId });
  }

  async compactSession(sessionId: string) {
    return this.client.session.compact({ sessionID: sessionId });
  }

  async context(sessionId: string) {
    return this.client.session.context({ sessionID: sessionId });
  }

  async diff(sessionId: string) {
    return this.client.session.diff({ sessionID: sessionId });
  }

  async vcsStatus(directory?: string) {
    return this.client.vcs.status(directory ? { location: { directory } } as any : undefined);
  }

  async vcsGet(directory?: string) {
    return this.client.vcs.get(directory ? { location: { directory } } as any : undefined);
  }

  async vcsBranches(directory?: string) {
    return this.client.vcs.branch.list(directory ? { location: { directory } } as any : undefined);
  }

  async worktreeList(directory?: string) {
    return this.client.worktree.list(directory ? { location: { directory } } as any : undefined);
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