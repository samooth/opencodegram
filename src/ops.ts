import { createServer } from "node:http";
import { statfsSync } from "node:fs";
import type { Config } from "./config.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./store.js";
import type { MetricsStore } from "./metrics.js";
import type { TelegramClient } from "./telegram.js";
import { formatBytes } from "./files/index.js";
import { esc } from "./util.js";

export type OpsServer = {
  url: string;
  stop: () => void;
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
  let lastDiskAlert = 0;

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

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      const ocInfo = await oc.serverInfo().catch(() => null);
      const disk = diskInfo();
      response.setHeader("Content-Type", "application/json");
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
        metrics: metrics.snapshot(),
      }));
      return;
    }
    if (url.pathname === "/metrics") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        uptimeSeconds: Math.round(process.uptime()),
        memory: process.memoryUsage(),
        counters: metrics.snapshot(),
      }));
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

  server.listen(port, host, () => {
    // Server started.
  });

  return {
    url: `http://${host}:${port}`,
    stop: () => {
      clearInterval(interval);
      server.close();
    },
  };
}
