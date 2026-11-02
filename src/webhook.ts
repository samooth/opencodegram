import { createServer } from "node:http";
import type { BotDeps } from "./context.js";
import { processUpdate } from "./updates.js";
import type { TelegramUpdate } from "./telegram.js";

export type WebhookServer = { url: string; stop: () => void };

export function createWebhookServer(deps: BotDeps): WebhookServer {
  const { config, metrics } = deps;
  const host = "0.0.0.0";
  const port = config.WEBHOOK_PORT;
  const path = config.WEBHOOK_PATH;
  const secret = config.WEBHOOK_SECRET;
  const processed = new Set<number>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", mode: "webhook" }));
      return;
    }
    if (request.method === "POST" && url.pathname === path) {
      const providedSecret = request.headers["x-telegram-bot-api-secret-token"];
      // Fail closed: a webhook without a configured secret is not allowed.
      if (!secret || providedSecret !== secret) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let finished = false;
      const MAX_BODY = 1_000_000;
      request.on("data", (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > MAX_BODY) {
          finished = true;
          response.statusCode = 413;
          response.end("Payload Too Large");
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", async () => {
        if (finished) return;
        finished = true;
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const update = (raw ? JSON.parse(raw) : {}) as TelegramUpdate;
          if (typeof update.update_id === "number") {
            if (processed.has(update.update_id)) {
              response.statusCode = 200;
              response.end("OK");
              return;
            }
            processed.add(update.update_id);
            if (processed.size > 10000) {
              const oldest = processed.values().next().value;
              if (oldest !== undefined) processed.delete(oldest);
            }
          }
          metrics?.inc("webhook_updates");
          response.statusCode = 200;
          response.end("OK");
          await processUpdate(deps, update);
        } catch (err) {
          console.error("[webhook]", err);
          metrics?.recordError(String(err));
          if (!response.headersSent) {
            response.statusCode = 400;
            response.end("Bad Request");
          }
        }
      });
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });

  server.listen(port, host, () => {
    console.log(`[webhook] listening on http://${host}:${port}${path}`);
  });

  return {
    url: `http://${host}:${port}`,
    stop: () => server.close(),
  };
}
