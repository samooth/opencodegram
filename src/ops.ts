import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { statfsSync } from "node:fs";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { MetricsStore } from "./metrics.js";
import type { TelegramClient } from "./telegram.js";
import { formatBytes } from "./files/index.js";
import { esc } from "./util.js";
import { describeThrottles, throttleTotals } from "./ratethrottle.js";
import { readGpuInfo } from "./resources.js";
import { consumeWebCode, issueWebSession, verifyWebSession, WEB_SESSION_COOKIE } from "./webauth.js";

/** P2: self-contained Mission Control page (no external assets or scripts). */
export function webAppHtml(title: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0f14;color:#e6edf3}
body{margin:0;padding:2rem;max-width:1100px;margin:auto}
h1{font-size:1.4rem;margin:0 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.card{background:#151b23;border:1px solid #30363d;border-radius:12px;padding:1rem}
.card h2{font-size:1rem;margin:0 0 .5rem}
.ok{color:#3fb950}.busy{color:#d29922}.err{color:#f85149}
.muted{color:#8b949e;font-size:.85rem}
</style></head><body>
<h1>🎛 ${esc(title)}</h1>
<p class="muted">Solo privado · actualización automática cada 5 s</p>
<div class="grid" id="grid"></div>
<script>
async function load(){
 const r=await fetch('data.json'+location.search); if(!r.ok)return;
 const d=await r.json();
 document.getElementById('grid').innerHTML=d.sessions.map(s=>{
  const st=s.error?'err':s.working?'busy':'ok';
  const icon=s.error?'🔴':s.working?'🟡':'🟢';
  return '<div class="card"><h2>'+icon+' '+esc(s.id.slice(0,12))+'</h2>'+
   '<p class="'+st+'">'+(s.error?esc(s.error.slice(0,80)):s.working?'Trabajando…':s.stopped?'Detenido':'Lista')+'</p>'+
   '<p class="muted">'+esc(s.model||'sin modelo')+' · '+s.tokens+' tok'+(s.cost?' · $'+s.cost.toFixed(4):'')+'</p>'+
   '<p class="muted">'+esc((s.prompt||'').slice(0,90))+'</p></div>';
 }).join('')||'<p class="muted">Sin sesiones.</p>';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
load();setInterval(load,5000);
</script></body></html>`;
}

export type OpsServer = {
  url: string;
  stop: () => void;
  /** Reason the HTTP listener could not bind (e.g. EADDRINUSE), if any. */
  error: () => string | undefined;
  /** Actual bound port (useful when listening on port 0). */
  port: () => number | undefined;
};

export function createOpsServer(deps: {
  config: Config;
  oc: OpenCodeBridge;
  store: SessionStore;
  metrics: MetricsStore;
  tg?: TelegramClient;
  adminChatId?: number;
}): OpsServer {
  const { config, oc, store, metrics, tg, adminChatId } = deps;
  const host = config.OPS_HOST;
  const port = config.OPS_PORT;
  const guardPath = config.DISK_GUARD_PATH ?? process.cwd();
  const minFreeBytes = config.DISK_GUARD_MIN_FREE_MB * 1024 * 1024;
  // Bind to a non-loopback host (0.0.0.0, a LAN IP, …) and no token configured
  // -> protect the diagnostic endpoints rather than exposing them publicly.
  const loopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const opsToken = config.OPS_AUTH_TOKEN;
  const authRequired = !loopbackHost;
  let lastDiskAlert = 0;
  let listening = false;
  let boundPort: number | undefined;
  let listenError: string | undefined;

  function diskInfo() {
    try {
      const stats = statfsSync(guardPath);
      return {
        path: guardPath,
        freeBytes: stats.bavail * stats.bsize,
        totalBytes: stats.blocks * stats.bsize,
      };
    } catch {
      return { path: guardPath, freeBytes: null, totalBytes: null };
    }
  }

  function checkDisk() {
    const info = diskInfo();
    if (info.freeBytes !== null && info.freeBytes < minFreeBytes) {
      metrics.inc("disk_low");
      console.warn(`[ops] low disk space: ${formatBytes(info.freeBytes)} free on ${guardPath}`);
      const now = Date.now();
      if (tg && adminChatId && now - lastDiskAlert > 60 * 60 * 1000) {
        lastDiskAlert = now;
        tg.sendRichMessage(adminChatId, `⚠️ <b>Low disk space</b>\n${formatBytes(info.freeBytes)} free on <code>${esc(guardPath)}</code>.`).catch(() => {});
      }
    }
  }

  checkDisk();
  const interval = setInterval(checkDisk, 5 * 60 * 1000);

  const sessionToken = (request: IncomingMessage): string | undefined => {
    const cookie = request.headers.cookie;
    if (!cookie) return undefined;
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === WEB_SESSION_COOKIE) return rest.join("=");
    }
    return undefined;
  };
  /** Web app access: one-time code exchange, session cookie or legacy token. */
  const webAppAuthorized = (request: IncomingMessage, url: URL, response: ServerResponse): boolean => {
    // Exchange a single-use code for a short-lived HttpOnly cookie, then strip
    // the code from the URL so it cannot be replayed or leak via history.
    const code = url.searchParams.get("code");
    if (code && consumeWebCode(code) !== undefined) {
      const session = issueWebSession();
      response.setHeader(
        "Set-Cookie",
        `${WEB_SESSION_COOKIE}=${session.token}; Path=/app; HttpOnly; SameSite=Strict; Max-Age=${session.maxAge}`,
      );
      response.statusCode = 302;
      response.setHeader("Location", url.pathname);
      response.end("Redirect");
      return false;
    }
    if (verifyWebSession(sessionToken(request))) return true;
    const token = config.WEB_APP_TOKEN;
    if (token && url.searchParams.get("token") === token) return true;
    response.statusCode = 404;
    response.end("Not found");
    return false;
  };
  const authorized = (request: IncomingMessage, url: URL): boolean => {
    if (!authRequired) return true;
    if (!opsToken) {
      console.warn("[ops] OPS_HOST is not loopback and OPS_AUTH_TOKEN is unset: refusing diagnostic requests");
      return false;
    }
    const header = request.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
    return bearer === opsToken || url.searchParams.get("token") === opsToken;
  };
  const unauthorized = (response: ServerResponse): void => {
    response.statusCode = 401;
    response.setHeader("WWW-Authenticate", "Bearer");
    response.end("Unauthorized");
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/metrics" || url.pathname === "/ready") {
      if (!authorized(request, url)) { unauthorized(response); return; }
    }
    if (url.pathname === "/health") {
      const ocInfo = await oc.serverInfo().catch(() => null);
      const disk = diskInfo();
      response.setHeader("Content-Type", "application/json");
      const gpu = readGpuInfo();
      response.end(JSON.stringify({
        status: "ok",
        uptimeSeconds: Math.round(process.uptime()),
        opencode: ocInfo,
        sessions: store.sessionsById.size,
        disk: {
          path: disk.path,
          freeBytes: disk.freeBytes,
          totalBytes: disk.totalBytes,
          free: disk.freeBytes === null ? null : formatBytes(disk.freeBytes),
        },
        telegram: {
          throttles: describeThrottles(),
          totals: throttleTotals(),
        },
        gpu: gpu ? { name: gpu.name, usedMB: gpu.usedMB, totalMB: gpu.totalMB, util: gpu.util, temperature: gpu.temperature } : null,
        metrics: metrics.snapshot(),
      }));
      return;
    }
    if (url.pathname === "/metrics") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        uptimeSeconds: Math.round(process.uptime()),
        memory: process.memoryUsage(),
        telegram: { throttles: describeThrottles(), totals: throttleTotals() },
        gpu: readGpuInfo(),
        counters: metrics.snapshot(),
      }));
      return;
    }
    if (url.pathname === "/app" || url.pathname === "/app/") {
      // Private Mission Control: single-use code (preferred), session cookie
      // or legacy static token. Stays off unless admin configured access.
      if (!webAppAuthorized(request, url, response)) return;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(webAppHtml(config.WEB_APP_TITLE || "Mission Control"));
      return;
    }
    if (url.pathname === "/app/data.json") {
      if (!webAppAuthorized(request, url, response)) return;
      response.setHeader("Cache-Control", "no-store");
      const sessions = [...store.sessionsById.values()].map((s) => ({
        id: s.sessionId,
        model: s.model ? `${s.model.providerID}/${s.model.id}` : undefined,
        working: !!s.statusMessageId && !s.statusFinished,
        stopped: !!s.stopped,
        error: s.lastTurnError,
        prompt: store.lastPromptBySession.get(s.sessionId),
        cost: s.cost,
        tokens: s.turnOutputTokens ?? s.lastOutputTokens ?? 0,
      }));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ sessions, metrics: metrics.snapshot(), at: Date.now() }));
      return;
    }
    if (url.pathname === "/ready") {
      try {
        await oc.serverInfo();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ready: true }));
      } catch (err) {
        response.statusCode = 503;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ready: false, error: String(err) }));
      }
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });

  // A busy port (another instance, a leftover process) must not crash the
  // daemon: the bot keeps working, only the health/metrics endpoints are off.
  server.on("error", (err: NodeJS.ErrnoException) => {
    listenError = err.code === "EADDRINUSE"
      ? `port ${port} already in use on ${host}`
      : (err.message || String(err));
    console.warn(`[ops] health endpoint disabled: ${listenError}`);
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address === "object") boundPort = address.port;
    listening = true;
  });

  return {
    url: `http://${host}:${port}`,
    error: () => listenError,
    port: () => boundPort,
    stop: () => {
      clearInterval(interval);
      if (listening) server.close();
      listening = false;
    },
  };
}
