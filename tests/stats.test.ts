import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectStats, recordTurnStat, renderStatsPanel, buildHtmlReport, writeStatsReport, countTools } from "../src/stats.js";

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-stats-test-"));
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  return root;
}

describe("model statistics", () => {
  test("records and aggregates a turn idempotently", () => {
    const root = makeDir();
    try {
      const dataDir = join(root, "data");
      const input = {
        sessionId: "s1", turnSeq: 1, chatId: 7, providerID: "kilo", modelID: "beam-free",
        status: "ok" as const, startedAt: Date.now() - 5000, finishedAt: Date.now(), durationMs: 5000,
        inputTokens: 100, outputTokens: 200, cost: 0.01, toolCalls: 2, editFiles: 1, addedLines: 5, removedLines: 2,
        toolCounts: countTools([
          { name: "shell", status: "success" },
          { name: "edit", status: "failed" },
          { name: "read", status: "success" },
          { name: "grep", status: "success" },
          { name: "bash", status: "failed" },
        ]),
      };
      recordTurnStat(input, dataDir);
      recordTurnStat(input, dataDir);
      const data = collectStats({ period: "all", scope: "chat", chatId: 7, dataDir });
      expect(data.totals.turns).toBe(1);
      expect(data.totals.outputTokens).toBe(200);
      // shell + bash = 2 shell calls, 1 failure (bash); 1 edit failed; 1 read; 1 search.
      expect(data.totals.tools.shell.calls).toBe(2);
      expect(data.totals.tools.shell.failures).toBe(1);
      expect(data.totals.tools.edit.calls).toBe(1);
      expect(data.totals.tools.edit.failures).toBe(1);
      expect(data.totals.tools.read.calls).toBe(1);
      expect(data.totals.tools.search.calls).toBe(1);
      expect(data.models[0]?.tools.shell.calls).toBe(2);
      expect(data.totals.toolsPerMin).toBeGreaterThan(0);
      expect(data.models.length).toBe(1);
      expect(data.models[0].providerID).toBe("kilo");
      expect(data.providers[0].turns).toBe(1);
      expect(data.days.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Telegram panel is structured and readable", () => {
    const root = makeDir();
    try {
      const dataDir = join(root, "data");
      recordTurnStat({
        sessionId: "s2", turnSeq: 1, chatId: 7, providerID: "kilo", modelID: "beam-free",
        status: "ok", startedAt: Date.now() - 3000, finishedAt: Date.now(), durationMs: 3000,
        inputTokens: 50, outputTokens: 120, cost: 0.005, toolCalls: 1,
      }, dataDir);
      const data = collectStats({ period: "all", scope: "chat", chatId: 7, dataDir });
      const panel = renderStatsPanel(data, { period: "all", scope: "chat", isAdmin: false });
      expect(panel.html).toContain("<b>Indicadores</b>");
      expect(panel.html).toContain("<b>🏆 Modelos · herramientas por minuto</b>");
      expect(panel.html).toContain("kilo/beam-free");
      expect(panel.html).toContain("<table compact striped>");
      expect(panel.html).toContain("<b>100%</b>");
      expect(panel.html).toContain("Modelo</td><td>tok/s</td><td>Sh</td><td>Ed</td><td>Le</td><td>Bu</td><td>Ot</td><td>✗</td><td>/min</td>");
      expect(panel.html).toContain("llamadas por minuto de turno");
      expect(panel.html).toContain("<b>🌐 Proveedores</b>");
      expect(panel.html).toContain("1 modelo");
      expect(panel.html).toContain("del tráfico");
      expect(panel.keyboard.length).toBeGreaterThanOrEqual(3);
      expect(panel.keyboard.some((row) => row.some((b) => b.callback_data.startsWith("stats:export:")))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("HTML report is self-contained and responsive", () => {
    const root = makeDir();
    try {
      const dataDir = join(root, "data");
      const data = collectStats({ period: "7d", scope: "chat", chatId: 7, dataDir });
      const html = buildHtmlReport(data, { period: "7d", scope: "chat" });
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("@media(max-width:720px)");
      expect(html).toContain("Rendimiento de <span>modelos</span>");
      expect(html).toContain("Herramientas por modelo");
      expect(html).toContain("llam./min");
      expect(html).not.toContain("<script src=");
      const { path, filename } = writeStatsReport(data, { period: "7d", scope: "chat" });
      expect(filename.endsWith(".html")).toBe(true);
      expect(path.length).toBeGreaterThan(0);
      rmSync(path, { force: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
