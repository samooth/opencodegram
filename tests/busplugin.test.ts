import { describe, expect, test } from "bun:test";
import { busPluginInstalled, isBusCallText, isBusToolName, parseBusCalls, parseBusEnvelope } from "../src/busplugin.js";
import { renderVirtualShell } from "../src/status-render.js";
import { renderBusBlock } from "../src/status-render.js";

describe("agent-bus plugin support", () => {
  test("detects plugin tools by name", () => {
    expect(isBusToolName("bus_send")).toBe(true);
    expect(isBusToolName("bus_alias")).toBe(true);
    expect(isBusToolName("execute")).toBe(false);
  });

  test("parses the protocol envelope", () => {
    const env = parseBusEnvelope("[FROM @lead | TO @dev | 2026-11-27T00:00:00Z | ID MSG-1 | TYPE REPORT | REPLY-TO MSG-0]");
    expect(env?.from).toBe("lead");
    expect(env?.to).toBe("dev");
    expect(env?.id).toBe("MSG-1");
    expect(env?.type).toBe("REPORT");
    expect(env?.replyTo).toBe("MSG-0");
  });

  test("native bus_<method> tools render in the bus section", () => {
    const details = [
      {
        id: "1",
        name: "bus_alias",
        input: JSON.stringify({ alias: "nginx-writer", role: "dev" }),
        status: "success",
      },
    ] as any;
    const html = renderBusBlock(details, "ses_x");
    expect(html).toContain('data="block:bus:ses_x"');
    expect(html).toContain("📨 agent-bus (1)");
    expect(html).toContain("bus:alias nginx-writer (dev)");
    expect(html).not.toContain("{" );
  });


  test("groups several bus:send calls that use a message array", () => {
    const code = [
      'const msgs = [',
      '  { to: "AtlasKV dev", type: "DECISION", replyTo: "MSG-1", subject: "Ajusta el guard de VRAM", body: "Medido 3126/4715 MiB" },',
      '  { to: "AtlasKV dev", type: "ALERT", subject: "Contraprueba", body: "Simular free por debajo del umbral" },',
      '];',
      'for (const msg of msgs) await tools.bus.send(msg);',
    ].join("\n");
    const calls = parseBusCalls(code);
    expect(calls).toHaveLength(2);
    expect(calls[0].args.to).toBe("AtlasKV dev");
    expect(calls[0].args.replyTo).toBe("MSG-1");
    const details = [{ id: "1", name: "execute", input: JSON.stringify({ code }), status: "success" }] as any;
    const html = renderBusBlock(details, "ses_x");
    expect(html).toContain("📨 agent-bus (2)");
    expect(html).toContain("Ajusta el guard de VRAM");
    expect(html).toContain("Contraprueba");
    expect(html).not.toContain("const msgs");
    expect(renderVirtualShell(details, 200)).not.toContain("tools.bus");
  });
  test("plugin detection returns a boolean without throwing", () => {
    expect(typeof busPluginInstalled()).toBe("boolean");
  });
});

test("truncated bus calls are still detected", () => {
  const truncated = 'return await tools.bus.send({ to: "F4 dev", type: "REPORT", subject: "muy largo...';
  expect(isBusCallText(truncated)).toBe(true);
  expect(isBusCallText("return await compute();")).toBe(false);
});
