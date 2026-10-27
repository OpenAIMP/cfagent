/**
 * Issue #1959 — BrowserAgent → PortThink migration pins.
 *
 * Why source-evidence + mocked-base behavior, not a real Think turn:
 * BrowserAgent has no turn path (no onChatMessage, no model/tools/
 * system-prompt hooks, no port hooks — see the chat-mapping note in
 * src/agents/browserAgent.ts), and node vitest cannot host a real
 * Think turn (tracker #1951; thinkAdapter's @cloudflare/think graph
 * needs workerd schemes). So this file pins what the migration
 * actually changes and what it must preserve: the base class and
 * import surface, the absence of any chat override, and the domain
 * methods + HTTP onRequest behavior under a PortThink-shaped base.
 * The real Think turn path is pinned by the foundation's workerd
 * proof (#1935), not re-proven here with a fake.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Same idiom as tests/browser_and_slack_agents.test.ts: the real
// thinkAdapter module imports @cloudflare/think (workerd-only), so
// mock it with a plain base class carrying ctx/env.
vi.mock("../src/actors/thinkAdapter", () => {
  return {
    PortThink: class MockPortThink {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { BrowserAgent } from "../src/agents/browserAgent";
import { AGENT_DIDS } from "../src/agents/did";
import type { Env } from "../src/types";

const ROOT = path.resolve(__dirname, "..");
// Strip comments first: the migration note above the class names the
// chat hooks it deliberately does NOT define, so a raw scan would
// false-positive on its own documentation.
const src = fs
  .readFileSync(path.join(ROOT, "src/agents/browserAgent.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("BrowserAgent → PortThink (#1959)", () => {
  it("extends PortThink from the actor adapter, not AIChatAgent or raw Think", () => {
    expect(src).toContain('import { PortThink } from "../actors/thinkAdapter"');
    expect(src).toMatch(/export class BrowserAgent extends PortThink\b/);
    expect(src).not.toContain("@cloudflare/ai-chat");
    expect(src).not.toContain("@cloudflare/think");
    expect(src).not.toContain("AIChatAgent");
  });

  it("defines no chat overrides and sets no port hooks (the mapping's core fact)", () => {
    for (const name of [
      "onChatMessage",
      "getModel(",
      "getTools(",
      "getSystemPrompt(",
      "onChatResponse",
      "onChatError",
      "portHooks",
    ]) {
      expect(src, name).not.toContain(name);
    }
  });

  it("keeps its domain methods and HTTP onRequest under the PortThink base", async () => {
    const mockEnv = {
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
    } as unknown as Env;
    const ctx = {
      id: { toString: () => "browser-test" },
      storage: {},
      waitUntil: vi.fn(),
    };
    const agent = new BrowserAgent(ctx as any, mockEnv);
    // Base-class surface the callers rely on: ctx/env passthrough.
    expect((agent as any).ctx).toBe(ctx);
    expect((agent as any).env).toBe(mockEnv);

    const healthReq = new Request("https://agent.internal/browser/health", {
      method: "GET",
    });
    const healthRes = await agent.onRequest(healthReq);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as any;
    expect(healthJson.agent).toBe("BrowserAgent");
    expect(healthJson.status).toBe("active");
    expect(healthJson.did).toBe(AGENT_DIDS.BROWSER);
    expect(healthJson.capabilities).toEqual([
      "transaction_snap",
      "page_snapshot",
      "dom_scraping",
    ]);

    // The domain methods still exist on the migrated class (behavior
    // itself is pinned by tests/browser_and_slack_agents.test.ts).
    expect(typeof agent.sendTransactionSnapToSlack).toBe("function");
    expect(typeof agent.capturePageSnapshot).toBe("function");
    expect(typeof agent.scrapeTables).toBe("function");
    expect(typeof agent.generateTransactionReceiptSvgBase64).toBe("function");
  });
});
