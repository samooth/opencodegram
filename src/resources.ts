import os from "node:os";
import { execFileSync } from "node:child_process";
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

let gpuCache: { time: number; value: GpuInfo | null } | null = null;
const GPU_CACHE_TTL_MS = 5000;

export function readGpuInfo(): GpuInfo | null {
  const now = Date.now();
  if (gpuCache && now - gpuCache.time < GPU_CACHE_TTL_MS) return gpuCache.value;
  let value: GpuInfo | null = null;
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 1500, encoding: "utf8" },
    )
      .trim()
      .split("\n")[0];
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
  } catch {
    // No GPU or nvidia-smi unavailable.
  }
  gpuCache = { time: now, value };
  return value;
}

export function readMemoryPercent(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const total = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1]);
    const available = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0) {
      return Math.max(0, Math.min(100, Math.round((1 - available / total) * 100)));
    }
  } catch {
    // Fall back to os.freemem() on non-Linux or permission errors.
  }
  return Math.max(0, Math.min(100, Math.round((1 - os.freemem() / os.totalmem()) * 100)));
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
  const gpu = readGpuInfo();
  if (gpu) {
    const vramPercent = Math.round((gpu.usedMB / gpu.totalMB) * 100);
    const vramBar = progressBar(vramPercent);
    const temp = gpu.temperature === null ? "" : ` · ${gpu.temperature}°C`;
    resourceLines.push(`GPU ${String(gpu.name).slice(0, 18)}`);
    resourceLines.push(`VRAM ${vramBar} ${vramPercent}%${temp}`);
    resourceLines.push(`Load ${progressBar(gpu.util)} ${gpu.util}%${temp}`);
  }
  return `<pre>${esc(resourceLines.join("\n"))}</pre>`;
}
