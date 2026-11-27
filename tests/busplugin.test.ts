import { describe, expect, test } from "bun:test";
import { busPluginInstalled, isBusToolName, parseBusEnvelope } from "../src/busplugin.js";
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
    expect(html).toContain('data="block:bus:ses_x:0"');
    expect(html).toContain("📨 bus:alias nginx-writer (dev)");
    expect(html).not.toContain("{" );
  });

  test("plugin detection returns a boolean without throwing", () => {
    expect(typeof busPluginInstalled()).toBe("boolean");
  });
});
