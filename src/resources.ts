import os from "node:os";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChatSession } from "./types.js";
import { contextUsage, esc } from "./util.js";

/**
 * System indicators (CPU, RAM, GPU, VRAM, temperature).
 *
 * They are rendered as the last block of EVERY message so the user always
 * sees the state of the machine right under the content.
 */

export function progressBar(percent: number, width = 10, theme: "auto" | "light" | "dark" = "auto"): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  // "auto" uses medium-density glyphs that read well on both light and dark
  // Telegram themes. Light uses solid shapes, dark uses outline-friendly ones.
  const [full, empty] = theme === "light" ? ["▰", "▱"] : theme === "dark" ? ["●", "○"] : ["▓", "░"];
  return full.repeat(filled) + empty.repeat(width - filled);
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


/** Trigger a GPU cache refresh without blocking a render. */
export function ensureGpuCache(): void {
  refreshGpuCache();
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

/** Compact token label for the CTX line: 354k, 128k, 1M. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    const rounded = Math.round((value / 1_000_000) * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * Render the indicators block. Always returns a non-empty block so the
 * indicators are present at the bottom of every message.
 */
const resourceCache = new WeakMap<ChatSession, { key: string; html: string }>();

// `os.cpus()` builds an array of per-core objects; the count never changes.
const CPU_COUNT = Math.max(1, os.cpus().length);

export function renderResourceBlock(s: ChatSession, opts: { history?: number; theme?: "auto" | "light" | "dark" } = {}): string {
  const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / CPU_COUNT) * 100));
  const memPercent = readMemoryPercent();
  const gpuNow = readGpuInfo();
  // One source of truth for the glyph set. Callers pass the chat theme; never
  // mutate s.cardTheme (that caused CPU/RAM and GPU bars to disagree).
  const theme = opts.theme ?? s.cardTheme ?? "auto";
  const key = [cpuPercent, memPercent, s.lastContextTokens ?? 0, s.contextWindow ?? 0, gpuNow?.usedMB ?? 0, gpuNow?.totalMB ?? 0, gpuNow?.util ?? 0, gpuNow?.temperature ?? "", theme].join("|");
  const cached = resourceCache.get(s);
  if (cached?.key === key) return cached.html;
  if (!s.cpuHistory) s.cpuHistory = [];
  if (!s.memHistory) s.memHistory = [];
  s.cpuHistory.push(cpuPercent);
  s.memHistory.push(memPercent);
  const limit = Math.max(2, Math.min(60, Math.round(opts.history ?? 12)));
  while (s.cpuHistory.length > limit) s.cpuHistory.shift();
  while (s.memHistory.length > limit) s.memHistory.shift();
  const cpuBar = progressBar(cpuPercent, 10, theme);
  const cpuTrend = s.cpuHistory.length >= 2 ? (s.cpuHistory[s.cpuHistory.length - 2] > cpuPercent ? " ↓" : s.cpuHistory[s.cpuHistory.length - 2] < cpuPercent ? " ↑" : "") : "";
  const memBar = progressBar(memPercent, 10, theme);
  const memTrend = s.memHistory.length >= 2 ? (s.memHistory[s.memHistory.length - 2] > memPercent ? " ↓" : s.memHistory[s.memHistory.length - 2] < memPercent ? " ↑" : "") : "";
  const resourceLines: string[] = [];
  resourceLines.push(`CPU ${cpuBar} ${cpuPercent}%${cpuTrend}`);
  resourceLines.push(`RAM ${memBar} ${memPercent}%${memTrend}`);
  const usage = contextUsage(s.lastContextTokens, s.contextWindow);
  if (usage) {
    // Same bar as CPU/RAM; the compact total and the percentage go at the end.
    const ctxBar = progressBar(Math.min(100, usage.percent), 10, theme);
    const flag = usage.over ? "⚠ " : "";
    resourceLines.push(`CTX ${ctxBar} ${compactTokens(s.lastContextTokens!)} / ${compactTokens(s.contextWindow!)} (${flag}${usage.percent}%)`);
  } else if (typeof s.lastContextTokens === "number" && s.lastContextTokens > 0) {
    resourceLines.push(`CTX ${compactTokens(s.lastContextTokens)}`);
  }
  const gpu = gpuNow;
  if (gpu) {
    const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
    const vramBar = progressBar(vramPercent, 10, theme);
    const tempStr = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
    resourceLines.push(`GPU ${String(gpu.name).slice(0, 18)}${tempStr}`);
    resourceLines.push(`VRAM ${vramBar} ${vramPercent}%`);
    resourceLines.push(`Load ${progressBar(gpu.util, 10, theme)} ${gpu.util}%`);
  }
  const html = `<pre>${esc(resourceLines.join("\n"))}</pre>`;
  resourceCache.set(s, { key, html });
  return html;
}

/** Plain data snapshot for widgets/APIs (no HTML). */
export function readResourceSnapshot(): {
  cpu: number;
  mem: number;
  gpu: GpuInfo | null;
  cpuCount: number;
  loadAvg: number;
  totalMemMB: number;
  freeMemMB: number;
} {
  const cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / CPU_COUNT) * 100));
  const memPercent = readMemoryPercent();
  const gpu = readGpuInfo();
  return {
    cpu: cpuPercent,
    mem: memPercent,
    gpu,
    cpuCount: CPU_COUNT,
    loadAvg: os.loadavg()[0],
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
  };
}
