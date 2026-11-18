import { readFile } from "node:fs/promises";
import type { OpenCodeBridge } from "./opencode.js";
import { fileErrorMessage, prepareDocument, resolveSafePath } from "./files/index.js";
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

type McpServerRaw = {
  status?: string | { status?: unknown; error?: unknown };
  error?: unknown;
};
function serverStatus(server: McpServerRaw): { status: string; error?: string } {
  const raw = server?.status;
  const status = (typeof raw === "object" && raw !== null ? raw.status : raw) ?? "unknown";
  const error = (typeof raw === "object" && raw !== null ? raw.error : undefined) ?? server?.error;
  return { status: String(status), error: error === undefined ? undefined : String(error) };
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
  const res = await oc.client.mcp.list(directory ? ({ location: { directory } } as unknown as Parameters<typeof oc.client.mcp.list>[0]) : undefined);
  const list = ((res as { data?: unknown })?.data ?? (Array.isArray(res) ? res : [])) as unknown[];
  return (list as Array<McpServerRaw & { name?: string; id?: string; title?: string }>).map((server) => ({
    name: server.name ?? server.id ?? "unnamed",
    status: serverStatus(server).status,
    title: server.title,
    error: serverStatus(server).error,
  }));
}

export async function connectMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.connect({ server: name, location: directory ? { directory } : undefined } as unknown as Parameters<typeof oc.client.mcp.connect>[0]);
}

export async function disconnectMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.disconnect({ server: name, location: directory ? { directory } : undefined } as unknown as Parameters<typeof oc.client.mcp.disconnect>[0]);
}

export async function removeMcpServer(oc: OpenCodeBridge, name: string, directory?: string): Promise<void> {
  await oc.client.mcp.remove({ server: name, location: directory ? { directory } : undefined } as unknown as Parameters<typeof oc.client.mcp.remove>[0]);
}

export async function listMcpResources(oc: OpenCodeBridge, directory?: string): Promise<{ resources: McpResourceInfo[]; templates: McpResourceInfo[] }> {
  const res = await oc.client.mcp.resource.catalog(directory ? ({ location: { directory } } as unknown as Parameters<typeof oc.client.mcp.resource.catalog>[0]) : undefined);
  const data = ((res as { data?: unknown })?.data ?? res ?? {}) as { resources?: unknown[]; templates?: unknown[] };
  const resources = Array.isArray(data.resources) ? data.resources : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
  return {
    resources: (resources as Array<{ server?: string; name?: string; uri?: string; description?: string; mimeType?: string }>).map((item) => ({
      server: item.server ?? "",
      name: item.name ?? "",
      uri: item.uri ?? "",
      description: item.description,
      mimeType: item.mimeType,
    })),
    templates: (templates as Array<{ server?: string; name?: string; uri?: string; uriTemplate?: string; description?: string; mimeType?: string }>).map((item) => ({
      server: item.server ?? "",
      name: item.name ?? "",
      uri: item.uriTemplate ?? item.uri ?? "",
      description: item.description,
      mimeType: item.mimeType,
    })),
  };
}

export async function readMcpResource(uri: string, directory?: string): Promise<{ text?: string; buffer?: Buffer; mimeType?: string; error?: string }> {
  if (/^https?:\/\//i.test(uri)) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "Unsupported URI scheme." };
      const { lookup } = await import("node:dns/promises");
      const host = parsed.hostname;
      const blocked = (ip: string) => {
        const lower = ip.toLowerCase();
        if (lower === "127.0.0.1" || lower === "::1" || lower === "0.0.0.0" || lower === "::") return true;
        if (lower.startsWith("10.") || lower.startsWith("192.168.") || lower.startsWith("169.254.") || lower.startsWith("172.16.") || lower.startsWith("172.17.") || lower.startsWith("172.18.") || lower.startsWith("172.19.") || lower.startsWith("172.2") || lower.startsWith("172.30.") || lower.startsWith("172.31.")) return true;
        if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:") || lower.startsWith("ff")) return true; // IPv6 ULA/link-local/multicast
        if (lower === "169.254.169.254") return true;
        return false;
      };
      if (host === "localhost" || host.endsWith(".localhost")) return { error: "Blocked host." };
      const resolved = await lookup(host);
      if (blocked(resolved.address)) return { error: "Blocked host (private/loopback)." };
      const response = await fetch(uri, { redirect: "error" });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const contentType = response.headers.get("content-type") ?? "";
      const reader = response.body?.getReader();
      if (!reader) return { error: "No body." };
      const chunks: Uint8Array[] = [];
      let total = 0;
      const MAX = 2_000_000;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX) { reader.cancel(); return { error: "Resource too large." }; }
        chunks.push(value);
      }
      const bufs = chunks.map((c) => Buffer.from(c));
      const text = Buffer.concat(bufs).toString("utf8");
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
  const text = `<b>Servidores MCP</b>\n${formatMcpServers(servers)}\n\n<i>Directorio: ${esc(directory)}</i>`;
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = servers.map((server) => {
    const buttons: Array<{ text: string; callback_data: string }> = [];
    if (server.status === "connected") buttons.push({ text: "Desconectar", callback_data: `mcp:disconnect:${server.name}` });
    else buttons.push({ text: "Conectar", callback_data: `mcp:connect:${server.name}` });
    buttons.push({ text: "Eliminar", callback_data: `mcp:remove:${server.name}` });
    return buttons;
  });
  keyboard.push([{ text: "Recursos", callback_data: "mcp:resources" }, { text: "🏠 Panel", callback_data: "panel:home" }]);
  return { text, keyboard };
}
export function formatMcpServers(servers: McpServerInfo[]): string {
  if (!servers.length) return "No MCP servers configured.";
  return servers
    .map((server) => `${mcpStatusEmoji(server.status)} <b>${esc(server.name)}</b>${server.title ? " — " + esc(server.title) : ""}\n   status: <code>${esc(server.status)}</code>${server.error ? "\n   error: " + esc(server.error) : ""}`)
    .join("\n\n");
}
