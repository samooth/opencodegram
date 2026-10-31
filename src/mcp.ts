import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OpenCodeBridge } from "./opencode.js";
import { fileErrorMessage, formatBytes, prepareDocument, resolveSafePath } from "./files.js";
import { esc } from "./util.js";

export type McpServerInfo = {
  name: string;
  status: string;
  title?: string;
  error?: string;
};

export type McpResourceInfo = {
  server: string;
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
};

function serverStatus(server: any): { status: string; error?: string } {
  const status = server?.status?.status ?? server?.status ?? "unknown";
  const error = server?.status?.error ?? server?.error;
  return { status: String(status), error };
}

export function mcpStatusEmoji(status: string): string {
  switch (status) {
    case "connected":
      return "✅";
    case "pending":
      return "⏳";
    case "disabled":
      return "⛔";
    case "failed":
      return "❌";
    case "needs_auth":
      return "🔐";
    default:
      return "•";
  }
}

export async function listMcpServers(oc: OpenCodeBridge, directory?: string): Promise<McpServerInfo[]> {
  const res = await oc.client.mcp.list(directory ? ({ location: { directory } } as any) : undefined);
  const list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
  return list.map((server: any) => ({
    name: server.name ?? server.id ?? "unnamed",
    status: serverStatus(server).status,
    title: server.title,
    error: serverStatus(server).error,
  }));
}

export async function connectMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.connect({ server: name, location: directory ? { directory } : undefined } as any);
}

export async function disconnectMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.disconnect({ server: name, location: directory ? { directory } : undefined } as any);
}

export async function removeMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.remove({ server: name, location: directory ? { directory } : undefined } as any);
}

export async function listMcpResources(oc: OpenCodeBridge, directory?: string): Promise<{ resources: McpResourceInfo[]; templates: McpResourceInfo[] }> {
  const res = await oc.client.mcp.resource.catalog(directory ? ({ location: { directory } } as any) : undefined);
  const data = ((res as { data?: unknown })?.data ?? res ?? {}) as { resources?: unknown[]; templates?: unknown[] };
  const resources = Array.isArray(data.resources) ? data.resources : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
  return {
    resources: resources.map((item: any) => ({
      server: item.server,
      name: item.name,
      uri: item.uri,
      description: item.description,
      mimeType: item.mimeType,
    })),
    templates: templates.map((item: any) => ({
      server: item.server,
      name: item.name,
      uri: item.uriTemplate ?? item.uri,
      description: item.description,
      mimeType: item.mimeType,
    })),
  };
}

export async function readMcpResource(uri: string, directory?: string): Promise<{ text?: string; buffer?: Buffer; mimeType?: string; error?: string }> {
  if (/^https?:\/\//i.test(uri)) {
    try {
      const response = await fetch(uri);
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();
      return { text, mimeType: contentType };
    } catch (err) {
      return { error: String(err) };
    }
  }
  if (/^file:\/\//i.test(uri)) {
    try {
      const filePath = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
      const safe = await resolveSafePath(directory ?? process.cwd(), filePath);
      const doc = await prepareDocument(safe.base, safe.relative || filePath);
      const data = await readFile(doc.absolute);
      const text = data.toString("utf8");
      if (data.includes(0)) return { buffer: data, mimeType: "application/octet-stream" };
      return { text, mimeType: "text/plain" };
    } catch (err) {
      return { error: fileErrorMessage(err) };
    }
  }
  return { error: "Unsupported URI scheme. Use /mcp resources to inspect it in OpenCode." };
}

export async function renderMcpList(oc: OpenCodeBridge, directory: string): Promise<{ text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
  const servers = await listMcpServers(oc, directory);
  const text = `<b>MCP servers</b>\n${formatMcpServers(servers)}\n\n<i>Directory: ${esc(directory)}</i>`;
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = servers.map((server) => {
    const buttons: Array<{ text: string; callback_data: string }> = [];
    if (server.status === "connected") buttons.push({ text: "Disconnect", callback_data: `mcp:disconnect:${server.name}` });
    else buttons.push({ text: "Connect", callback_data: `mcp:connect:${server.name}` });
    buttons.push({ text: "Remove", callback_data: `mcp:remove:${server.name}` });
    return buttons;
  });
  keyboard.push([{ text: "Resources", callback_data: "mcp:resources" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
  return { text, keyboard };
}
export function formatMcpServers(servers: McpServerInfo[]): string {
  if (!servers.length) return "No MCP servers configured.";
  return servers
    .map((server) => `${mcpStatusEmoji(server.status)} <b>${esc(server.name)}</b>${server.title ? " — " + esc(server.title) : ""}\n   status: <code>${esc(server.status)}</code>${server.error ? "\n   error: " + esc(server.error) : ""}`)
    .join("\n\n");
}
