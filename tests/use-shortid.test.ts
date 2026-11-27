import { describe, expect, test } from "bun:test";
import { cmd_use } from "../src/commands/sessions.js";

function harness(fullId: string) {
  const sent: string[] = [];
  const activated: string[] = [];
  const deps = {
    config: { OPENCODE_DIRECTORY: "/tmp" },
    tg: {},
    oc: { listSessionsCached: async () => [] },
    store: {
      sessionsById: new Map([[fullId, { sessionId: fullId }]]),
      findSessionById: (id: string) => (id === fullId ? { sessionId: fullId } : undefined),
      routeKey: () => "k",
    },
    sessions: {
      activateSession: async (_chat: number, id: string) => { activated.push(id); return { sessionId: id }; },
      syncTopicTitle: async () => {},
    },
    panels: { showSessions: async () => {} },
  } as any;
  return { deps, sent, activated, send: (async (html: string) => { sent.push(html); return { message_id: 1 }; }) as any };
}

describe("/use with a short session id", () => {
  test("resolves the 8-char prefix shown in the card", async () => {
    const full = "ses_de33abc1234567890";
    const { deps, activated, sent, send } = harness(full);
    await cmd_use(deps, -100, 42, "/use ses_de33", send);
    expect(activated).toEqual([full]);
    expect(sent.join(" ")).toContain(full);
  });

  test("rejects an ambiguous prefix", async () => {
    const { deps, activated, sent, send } = harness("ses_de33aaa");
    deps.store.sessionsById.set("ses_de33bbb", { sessionId: "ses_de33bbb" });
    await cmd_use(deps, -100, 42, "/use ses_de33", send);
    expect(activated).toHaveLength(0);
    expect(sent.join(" ")).toContain("ambiguo");
  });
});
