import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createOpsServer } from "../src/ops.js";
import { MetricsStore } from "../src/metrics.js";

const TEST_ROOT = "/tmp/opencode";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(TEST_ROOT, "ocg-ops-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeOps(port: number, serverInfo: () => Promise<unknown> = async () => ({ version: "test" })) {
  return createOpsServer({
    config: {
      OPS_HOST: "127.0.0.1",
      OPS_PORT: port,
      DISK_GUARD_PATH: root,
      DISK_GUARD_MIN_FREE_MB: 0,
    } as any,
    oc: { serverInfo } as any,
    store: { sessionsById: new Map() } as any,
    metrics: new MetricsStore(),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await Bun.sleep(10);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return address && typeof address === "object" ? address.port : 0;
}

describe("ops server", () => {
  test("serves health and metrics on the bound port", async () => {
    const ops = makeOps(0);
    try {
      await waitFor(() => ops.port() !== undefined);
      const port = ops.port();
      expect(port).toBeGreaterThan(0);
      expect(ops.error()).toBeUndefined();

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const healthBody = await health.json();
      expect(healthBody.status).toBe("ok");
      expect(healthBody.sessions).toBe(0);
      expect(healthBody.opencode).toEqual({ version: "test" });

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      const metricsBody = await metrics.json();
      expect(typeof metricsBody.uptimeSeconds).toBe("number");
      expect(metricsBody.counters).toEqual({});

      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      ops.stop();
    }
  });

  test("/ready reports 503 when OpenCode is unreachable", async () => {
    const ops = makeOps(0, async () => {
      throw new Error("opencode down");
    });
    try {
      await waitFor(() => ops.port() !== undefined);
      const ready = await fetch(`http://127.0.0.1:${ops.port()}/ready`);
      expect(ready.status).toBe(503);
      const body = await ready.json();
      expect(body.ready).toBe(false);
      expect(String(body.error)).toContain("opencode down");
    } finally {
      ops.stop();
    }
  });

  test("a busy port logs an error instead of crashing the daemon", async () => {
    const blocker = createServer((_request, response) => response.end("busy"));
    const busyPort = await listen(blocker);
    const ops = makeOps(busyPort);
    try {
      await waitFor(() => ops.error() !== undefined);
      expect(ops.error()).toContain("already in use");
      expect(ops.port()).toBeUndefined();
      // Stopping a server that never bound must be safe.
      expect(() => ops.stop()).not.toThrow();
    } finally {
      ops.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("ops auth on non-loopback hosts", () => {
  test("requires a token on /health, /metrics and /ready when OPS_HOST is not loopback", async () => {
    const server = createOpsServer({
      config: {
        OPS_HOST: "0.0.0.0",
        OPS_PORT: 0,
        DISK_GUARD_PATH: root,
        DISK_GUARD_MIN_FREE_MB: 0,
        OPS_AUTH_TOKEN: "supersecrettoken",
      } as any,
      oc: { serverInfo: async () => ({ version: "test" }) } as any,
      store: { sessionsById: new Map() } as any,
      metrics: new MetricsStore(),
    });
    // Bind uses 0.0.0.0 but is reachable via localhost.
    const port = server.port();
    if (!port) {
      // wait for the bound port
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    const p = server.port();
    expect(p).toBeGreaterThan(0);

    const noToken = await fetch(`http://127.0.0.1:${p}/health`);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toContain("Bearer");

    const badToken = await fetch(`http://127.0.0.1:${p}/health?token=wrong`);
    expect(badToken.status).toBe(401);

    const good = await fetch(`http://127.0.0.1:${p}/health?token=supersecrettoken`);
    expect(good.status).toBe(200);

    const bearer = await fetch(`http://127.0.0.1:${p}/metrics`, {
      headers: { authorization: "Bearer supersecrettoken" },
    });
    expect(bearer.status).toBe(200);

    const ready = await fetch(`http://127.0.0.1:${p}/ready?token=supersecrettoken`);
    expect(ready.status).toBe(200);
    server.stop();
  });

  test("refuses diagnostics when non-loopback and no token is configured", async () => {
    const server = createOpsServer({
      config: {
        OPS_HOST: "0.0.0.0",
        OPS_PORT: 0,
        DISK_GUARD_PATH: root,
        DISK_GUARD_MIN_FREE_MB: 0,
      } as any,
      oc: { serverInfo: async () => ({ version: "test" }) } as any,
      store: { sessionsById: new Map() } as any,
      metrics: new MetricsStore(),
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    const p = server.port();
    expect(p).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${p}/health`);
    expect(res.status).toBe(401);
    server.stop();
  });
});

describe("web app single-use codes", () => {
  test("exchanges a code for a session cookie and keeps data.json accessible", async () => {
    const { issueWebCode } = await import("../src/webauth.js");
    const server = createOpsServer({
      config: {
        OPS_HOST: "127.0.0.1",
        OPS_PORT: 0,
        DISK_GUARD_PATH: root,
        DISK_GUARD_MIN_FREE_MB: 0,
        WEB_APP_TOKEN: "staticfallbacktoken",
      } as any,
      oc: { serverInfo: async () => ({ version: "test" }) } as any,
      store: { sessionsById: new Map() } as any,
      metrics: new MetricsStore(),
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    const p = server.port();
    expect(p).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${p}`;

    const { code } = issueWebCode(999);
    // First request with the code: 302 + Set-Cookie, code consumed.
    const exchange = await fetch(`${base}/app?code=${encodeURIComponent(code)}`, { redirect: "manual" });
    expect(exchange.status).toBe(302);
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ocg_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(exchange.headers.get("location")).toBe("/app");

    // Replaying the same code is rejected (static token not present) -> 404.
    const replay = await fetch(`${base}/app?code=${encodeURIComponent(code)}`, { redirect: "manual" });
    expect(replay.status).toBe(404);

    const cookie = setCookie.split(";")[0];
    const page = await fetch(`${base}/app`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const data = await fetch(`${base}/app/data.json`, { headers: { cookie } });
    expect(data.status).toBe(200);

    server.stop();
  });
});
