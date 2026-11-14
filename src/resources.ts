import os from "node:os";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChatSession } from "./types.js";
import { esc } from "./util.js";

/**
 * System indicators (CPU, RAM, GPU, VRAM, temperature).
 *
 * They are rendered as the last block of EVERY message so the user always
 * sees the state of the machine right under the content.
 */

export function progressBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export type GpuInfo = { name: string; usedMB: number; totalMB: number; util: number; temperature: number | null };

let gpuCache: { time: number; value: GpuInfo | null; refreshing: boolean } | null = null;
const GPU_CACHE_TTL_MS = 5000;

export function refreshGpuCache(): void {
  if (gpuCache?.refreshing) return;
  if (!gpuCache) gpuCache = { time: 0, value: null, refreshing: true };
  else gpuCache.refreshing = true;

  execFile(
    "nvidia-smi",
    ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
    { timeout: 1500, encoding: "utf8" },
    (err, stdout) => {
      let value: GpuInfo | null = null;
      try {
        if (!err && typeof stdout === "string") {
          const out = stdout.trim().split("\n")[0] ?? "";
          const parts = out.split(",").map((s) => s.trim());
          if (parts.length >= 5) {
            const name = parts[0] || "GPU";
            const usedMB = Number(parts[1]);
            const totalMB = Number(parts[2]);
            const util = Number(parts[3]);
            const temperature = Number(parts[4]);
            if (Number.isFinite(usedMB) && Number.isFinite(totalMB) && totalMB > 0 && Number.isFinite(util)) {
              value = { name, usedMB, totalMB, util, temperature: Number.isFinite(temperature) ? temperature : null };
            }
          }
        }
      } catch {
        value = null;
      }
      gpuCache = { time: Date.now(), value, refreshing: false };
    },
  );
}

export function readGpuInfo(): GpuInfo | null {
  const now = Date.now();
  if (gpuCache && now - gpuCache.time < GPU_CACHE_TTL_MS) return gpuCache.value;
  // Cache stale or missing: return the last known value immediately and refresh
  // in the background so renders never block the event loop on nvidia-smi.
  const stale = gpuCache?.value ?? null;
  refreshGpuCache();
  return stale;
}


/** Await the GPU cache being populated (best-effort, with timeout). */
export async function ensureGpuCache(timeoutMs = 2000): Promise<void> {
  refreshGpuCache();
  // Non-blocking: trigger refresh and return immediately. The cache will
  // populate in the background; renders use the last known value.
  return;
}

let memCache: { time: number; value: number } | null = null;
const MEM_CACHE_TTL_MS = 2000;

export function readMemoryPercent(): number {
  const now = Date.now();
  if (memCache && now - memCache.time < MEM_CACHE_TTL_MS) return memCache.value;
  let percent: number | undefined;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1]);
    const available = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0) {
      percent = Math.max(0, Math.min(100, Math.round((1 - available / total) * 100)));
    }
  } catch {
    // Fall back to os.freemem() on non-Linux or permission errors.
  }
  if (percent === undefined) {
    percent = Math.max(0, Math.min(100, Math.round((1 - os.freemem() / os.totalmem()) * 100)));
  }
  memCache = { time: now, value: percent };
  return percent;
}

/**
 * Render the indicators block. Always returns a non-empty block so the
 * indicators are present at the bottom of every message.
 */
export function renderResourceBlock(s: ChatSession): string {
  if (!s.cpuHistory) s.cpuHistory = [];
  if (!s.memHistory) s.memHistory = [];
  const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
  const memPercent = readMemoryPercent();
  s.cpuHistory.push(cpuPercent);
  s.memHistory.push(memPercent);
  const limit = 12;
  while (s.cpuHistory.length > limit) s.cpuHistory.shift();
  while (s.memHistory.length > limit) s.memHistory.shift();
  const cpuBar = progressBar(cpuPercent);
  const cpuTrend = s.cpuHistory.length >= 2 ? (s.cpuHistory[s.cpuHistory.length - 2] > cpuPercent ? " ↓" : s.cpuHistory[s.cpuHistory.length - 2] < cpuPercent ? " ↑" : "") : "";
  const memBar = progressBar(memPercent);
  const memTrend = s.memHistory.length >= 2 ? (s.memHistory[s.memHistory.length - 2] > memPercent ? " ↓" : s.memHistory[s.memHistory.length - 2] < memPercent ? " ↑" : "") : "";
  const resourceLines: string[] = [];
  resourceLines.push(`CPU ${cpuBar} ${cpuPercent}%${cpuTrend}`);
  resourceLines.push(`RAM ${memBar} ${memPercent}%${memTrend}`);
  if (typeof s.lastContextTokens === "number" && s.lastContextTokens > 0) {
    if (typeof s.contextWindow === "number" && s.contextWindow > 0) {
      const pct = Math.min(100, Math.round((s.lastContextTokens / s.contextWindow) * 100));
      resourceLines.push(`CTX ${pct}% (${s.lastContextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tok)`);
    } else {
      resourceLines.push(`CTX ${s.lastContextTokens.toLocaleString()} tok`);
    }
  }
  const gpu = readGpuInfo();
  if (gpu) {
    const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
    const vramBar = progressBar(vramPercent);
    const tempStr = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
    resourceLines.push(`GPU ${String(gpu.name).slice(0, 18)}${tempStr}`);
    resourceLines.push(`VRAM ${vramBar} ${vramPercent}%`);
    resourceLines.push(`Load ${progressBar(gpu.util)} ${gpu.util}%`);
  }
  return `<pre>${esc(resourceLines.join("\n"))}</pre>`;
}
