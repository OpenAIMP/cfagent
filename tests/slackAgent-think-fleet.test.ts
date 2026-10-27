/**
 * Issue #1960 (think-fleet, tracker #1951) — SlackAgent PortThink
 * migration pins. Source-evidence style (repo precedent:
 * tests/agent-conformance.test.ts): the Agents SDK module graph
 * pulls `cloudflare:` imports the node loader cannot resolve, so
 * this suite pins the adoption evidence, not a live turn. The
 * chat-surface mapping it guards: SlackAgent defined no AIChatAgent
 * chat overrides and drove no turn, so the migration is the base
 * swap plus the unchanged Slack ingress and domain helpers — no
 * model/tools/prompt invented, no port hooks object.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(
  path.join(ROOT, "src/agents/slackAgent.ts"),
  "utf8"
);

describe("SlackAgent PortThink migration (#1960)", () => {
  it("extends PortThink via the adapter, not AIChatAgent or raw Think", () => {
    expect(src).toContain('import { PortThink } from "../actors/thinkAdapter"');
    expect(src).toMatch(/export class SlackAgent extends PortThink\b/);
    expect(src).not.toContain("@cloudflare/ai-chat");
    expect(src).not.toContain('from "@cloudflare/think"');
    // No extends/import of AIChatAgent: the header comment names it
    // while explaining the migration, so pin the code shapes, not
    // the bare word.
    expect(src).not.toMatch(/extends\s+AIChatAgent\b/);
    expect(src).not.toMatch(/import\s*\{[^}]*AIChatAgent[^}]*\}/);
  });

  it("defines no AI chat overrides and no port hooks (none existed to keep)", () => {
    // Definition patterns only: the header comment names these
    // hooks while explaining that none are defined, so a plain
    // substring check would false-positive on the comment itself.
    for (const pattern of [
      /\bonChatMessage\s*\(/,
      /\bonChatResponse\s*\(/,
      /\bonChatError\s*\(/,
      /\bgetModel\s*\(/,
      /\bgetSystemPrompt\s*\(/,
      /\bgetTools\s*\(/,
      /\bthis\.portHooks\b/,
      /\bportHooks\s*=/,
      /\brunTurn\s*\(/,
    ]) {
      expect(src, String(pattern)).not.toMatch(pattern);
    }
  });

  it("keeps the Slack ingress and domain surface unchanged", () => {
    expect(src).toContain("async onRequest(request: Request)");
    expect(src).toContain("sendPreTradeApprovalTicket");
    expect(src).toContain("dispatchTransactionSnap");
    expect(src).toContain("ETradeSlackTradingService");
    expect(src).toContain("gateSlackRequest");
  });
});
