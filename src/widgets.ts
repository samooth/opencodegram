import type { BotDeps } from "./context.js";
import { readResourceSnapshot } from "./resources.js";
import { logger } from "./logger.js";

/**
 * Handle a widget_query / shared_widget_query update: compute a fresh resource
 * snapshot and answer the bot within the 15s window. The widget redraws from
 * the returned data; no state change happens here.
 */
export async function handleWidgetQuery(deps: BotDeps, q: {
  id: string;
  from: { id: number };
  data: string;
  widget_id?: string;
}): Promise<void> {
  const { tg } = deps;
  try {
    if (q.data === "refresh" || q.data === "resources") {
      const snap = readResourceSnapshot();
      const payload = JSON.stringify({
        cpu: snap.cpu,
        mem: snap.mem,
        gpu: snap.gpu ? { name: snap.gpu.name, usedMB: snap.gpu.usedMB, totalMB: snap.gpu.totalMB, util: snap.gpu.util, temp: snap.gpu.temperature } : null,
        load: Number(snap.loadAvg.toFixed(2)),
        memTotalMB: snap.totalMemMB,
        ts: Date.now(),
      });
      await tg.answerWidgetQuery(q.id, payload);
      return;
    }
    await tg.answerWidgetQuery(q.id, JSON.stringify({ ok: true, echo: q.data }));
  } catch (err) {
    logger.warn("widgets", "answer failed", String(err));
    await tg.answerWidgetQuery(q.id, JSON.stringify({ error: "failed" })).catch(() => {});
  }
}

export const RESOURCE_WIDGET_HTML = `<style>body{margin:0;font-family:system-ui,sans-serif;color:var(--tg-theme-text-color, #000);background:var(--tg-theme-bg-color,#fff)} .wrap{padding:8px 12px} .row{display:flex;align-items:center;gap:8px;margin:6px 0} .label{width:44px;font-size:12px;color:var(--tg-theme-hint-color,#707579)} .bar{flex:1;height:8px;background:var(--tg-theme-secondary-bg-color,#f1f1f4);border-radius:4px;overflow:hidden} .fill{height:100%;background:var(--tg-theme-button-color,#3390ec);border-radius:4px;transition:width .3s} .val{width:44px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums} button{background:var(--tg-theme-button-color,#3390ec);color:var(--tg-theme-button-text-color,#fff);border:0;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer} .muted{color:var(--tg-theme-hint-color,#707579);font-size:11px;margin-top:6px}</style><div class="wrap"><div class="row"><span class="label">CPU</span><div class="bar"><div class="fill" id="cpu" style="width:0%"></div></div><span class="val" id="cpuV">-</span></div><div class="row"><span class="label">RAM</span><div class="bar"><div class="fill" id="ram" style="width:0%"></div></div><span class="val" id="ramV">-</span></div><div class="row" id="gpuRow" style="display:none"><span class="label">GPU</span><div class="bar"><div class="fill" id="gpu" style="width:0%"></div></div><span class="val" id="gpuV">-</span></div><button id="btn">Actualizar</button><div class="muted" id="ts">-</div></div><script>var T=window.TelegramWidget;function apply(d){if(!d)return;if(typeof d.cpu==='number'){document.getElementById('cpu').style.width=d.cpu+'%';document.getElementById('cpuV').textContent=d.cpu+'%';}if(typeof d.mem==='number'){document.getElementById('ram').style.width=d.mem+'%';document.getElementById('ramV').textContent=d.mem+'%';}if(d.gpu){document.getElementById('gpuRow').style.display='flex';document.getElementById('gpu').style.width=d.gpu.util+'%';document.getElementById('gpuV').textContent=d.gpu.util+'%';}if(d.ts){document.getElementById('ts').textContent=new Date(d.ts).toLocaleTimeString();}}function refresh(){if(!T||!T.request)return;T.request('refresh').then(function(a){try{apply(JSON.parse((a&&a.result)||'{}'))}catch(e){}}).catch(function(e){var el=document.getElementById('ts');if(el)el.textContent='err: '+(e&&e.code?e.code:e);});}var b=document.getElementById('btn');if(b)b.addEventListener('click',refresh);refresh();if(T)setInterval(refresh,5000);if(T&&T.ready)T.ready();</script>`;
