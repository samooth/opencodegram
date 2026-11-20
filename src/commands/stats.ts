import type { BotDeps, SendFn } from "../context.js";
import { ctx, isRouteAdmin } from "./shared.js";
import { collectStats, renderStatsPanel, writeStatsReport, type StatsPeriod, type StatsScope } from "../stats.js";
import { esc, threadOpts } from "../util.js";

function parsePeriod(token: string | undefined): StatsPeriod {
  return token === "30d" || token === "all" ? (token as StatsPeriod) : "7d";
}

export async function cmd_stats(deps: BotDeps, chatId: number, threadId: number | undefined, text: string, send: SendFn, userId?: number): Promise<boolean | void> {
  const C = ctx(deps);
  const args = text.slice("/stats".length).trim().split(/\s+/).filter(Boolean);
  const isAdmin = isRouteAdmin(deps, chatId, threadId, userId);

  let exportMode = false;
  let period: StatsPeriod = "7d";
  let scope: StatsScope = "chat";
  for (const arg of args) {
    if (arg === "export") { exportMode = true; continue; }
    if (arg === "7d" || arg === "30d" || arg === "all") { period = arg as StatsPeriod; continue; }
    if (arg === "global" || arg === "all-chats") { if (isAdmin) scope = "all"; continue; }
  }

  if (exportMode) {
    if (scope === "all" && !isAdmin) {
      await send("📊 Solo un admin puede exportar el histórico de todos los chats.");
      return true;
    }
    const data = collectStats({ period, scope, chatId, dataDir: C.store.dataDir });
    const { path, filename } = writeStatsReport(data, { period, scope, title: `OpenCodegram · ${scope === "all" ? "Todos los chats" : "Este chat"}` });
    const scopeLabel = scope === "all" ? "todos los chats" : "este chat";
    await C.tg.sendDocument(chatId, path, filename, `📊 <b>Reporte de rendimiento</b>\n<i>${period === "7d" ? "Últimos 7 días" : period === "30d" ? "Últimos 30 días" : "Histórico completo"} · ${scopeLabel}</i>\n${data.totals.turns} turnos · ${data.models.length} modelos`, {
      ...threadOpts(threadId),
      parse_mode: "HTML",
    }).catch(async (err) => {
      await send(`❌ No se pudo generar el reporte: ${esc(String(err))}`);
    });
    return true;
  }

  // Plain /stats [period] renders the panel.
  if (args[0] && (args[0] === "7d" || args[0] === "30d" || args[0] === "all")) {
    period = args[0] as StatsPeriod;
  }
  const data = collectStats({ period, scope, chatId, dataDir: C.store.dataDir });
  const panel = renderStatsPanel(data, { period, scope, isAdmin });
  await send(panel.html, { reply_markup: { inline_keyboard: panel.keyboard } });
  return true;
}
