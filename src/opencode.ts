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
    this.client = OpenCode.make({ baseUrl, headers });
  }

  async serverInfo() {
    return this.client.server.info();
  }

  async listSessions(): Promise<unknown> {
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
      const sessions = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
      const sorted = [...sessions].sort((a: any, b: any) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0));
      // Prefer a real project directory over the home directory.
      for (const _s of sorted) {
        const s = _s as { location?: { directory?: string }; directory?: string };
        const dir = s?.location?.directory ?? s?.directory;
        if (dir && dir !== process.env.HOME) return dir;
      }
      const first = sorted[0] as { location?: { directory?: string }; directory?: string } | undefined;
      return first?.location?.directory ?? first?.directory;
    } catch {
      return undefined;
    }
  }

  async listCommands(directory?: string) {
    try {
      const res = await this.client.command.list(directory ? { location: { directory } } as unknown as Parameters<typeof this.client.command.list>[0] : undefined);
      return (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as unknown[];
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
      const data = (res as { data?: { id?: string; providerID?: string; variants?: Array<{ id?: string }> } })?.data ?? res as { id?: string; providerID?: string; variants?: Array<{ id?: string }> };
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
    const res = await this.client.agent.list(directory ? { location: { directory } } as unknown as Parameters<typeof this.client.agent.list>[0] : undefined);
    return (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as unknown[];
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

  async listForms(sessionId: string) {
    return this.client.session.form.list({ sessionID: sessionId });
  }

  async getForm(sessionId: string, formId: string) {
    return this.client.session.form.get({ sessionID: sessionId, formID: formId });
  }

  async replyForm(sessionId: string, formId: string, answer: Record<string, string | number | boolean | string[]>) {
    return this.client.session.form.reply({ sessionID: sessionId, formID: formId, answer });
  }

  async cancelForm(sessionId: string, formId: string, message?: string) {
    return this.client.session.form.cancel({ sessionID: sessionId, formID: formId, message });
  }

  async diff(sessionId: string) {
    return this.client.session.diff({ sessionID: sessionId });
  }

  async vcsStatus(directory?: string) {
    return this.client.vcs.status(directory ? { location: { directory } } as unknown as Parameters<typeof this.client.vcs.status>[0] : undefined);
  }

  async vcsGet(directory?: string) {
    return this.client.vcs.get(directory ? { location: { directory } } as unknown as Parameters<typeof this.client.vcs.get>[0] : undefined);
  }

  async vcsBranches(directory?: string) {
    return this.client.vcs.branch.list(directory ? { location: { directory } } as unknown as Parameters<typeof this.client.vcs.branch.list>[0] : undefined);
  }

  async worktreeList(directory?: string) {
    const projectID = await this.projectID(directory);
    if (!projectID) return [];
    const res = await this.client.worktree.list({ projectID });
    return (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as unknown[];
  }

  async projectID(directory?: string) {
    const target = directory ?? process.cwd();
    const res = await this.client.project.list();
    const projects = (((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[]) as Array<{ id?: string; canonical?: string; directory?: string }>;
    const match = projects.find((project: any) => project.canonical === target || project.directory === target);
    return match?.id;
  }

  async worktreeCreate(directory: string | undefined, name: string, branch?: string) {
    const projectID = await this.projectID(directory);
    if (!projectID) throw new Error("Project not found for this directory");
    const res = await this.client.worktree.create({ projectID, name, branch });
    return (res as { data?: unknown })?.data ?? res;
  }

  async worktreeRemove(directory: string | undefined, worktreeDirectory: string, force = false) {
    const projectID = await this.projectID(directory);
    if (!projectID) throw new Error("Project not found for this directory");
    await this.client.worktree.remove({ projectID, directory: worktreeDirectory, force });
  }

  async worktreeRefresh(directory?: string) {
    const projectID = await this.projectID(directory);
    if (!projectID) return;
    await this.client.worktree.refresh({ projectID });
  }

  async sessionMove(sessionId: string, directory: string) {
    await this.client.session.move({ sessionID: sessionId, directory });
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