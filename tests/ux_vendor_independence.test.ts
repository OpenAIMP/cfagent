import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #1322: Pin test suite ensuring all user-facing UX strings in NextGenTP
 * are independent of cloud provider and infrastructure product names (Cloudflare Worker,
 * Workers AI, Durable Objects, DO Alarms, Vectorize RAG, R2 archival).
 * All capabilities must be presented as institutional business capabilities.
 */
describe("UX Vendor Independence & Capability Representation (Issue #1322)", () => {
  const root = resolve(__dirname, "..");
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");

  it("WorkflowsHub.tsx contains 0 vendor product references and presents institutional capabilities", () => {
    const content = read("src/client/WorkflowsHub.tsx");
    expect(content).not.toContain("Cloudflare Workers AI");
    expect(content).not.toContain("Cloudflare DO Alarms");
    expect(content).not.toContain("Cloudflare Durable Object");
    expect(content).not.toContain("Vectorize RAG");
    expect(content).not.toContain("R2 archival");
    expect(content).not.toContain("Cloudflare EMAIL Worker Binding");
    expect(content).not.toContain("Cloudflare Workers Telemetry");
    expect(content).not.toContain("Cloudflare Worker API Metrics");

    expect(content).toContain("Autonomous State Alarms");
    expect(content).toContain("Neural Strategy AI Engine");
    expect(content).toContain("Enterprise Vector RAG Intelligence Index");
    expect(content).toContain("Inbound Corporate Email Gateway");
    expect(content).toContain("cold-storage vault archival");
    expect(content).toContain("Upstream Subrequests &amp; Edge Execution Metrics");
  });

  it("ETradeTradingHub.tsx presents omnichannel trading desks and persistent ledger", () => {
    const content = read("src/client/ETradeTradingHub.tsx");
    expect(content).not.toContain("Cloudflare Agents SDK");
    expect(content).not.toContain("Cloudflare Email Trading Agent");
    expect(content).not.toContain("Cloudflare Slack Trading Agent");
    expect(content).not.toContain("Cloudflare Agents Voice SDK");
    expect(content).not.toContain("Cloudflare Durable Objects + SQLite");
    expect(content).not.toContain("Configured in Cloudflare");

    expect(content).toContain("Autonomous Multi-Agent Architecture");
    expect(content).toContain("Autonomous Email Trading Desk");
    expect(content).toContain("Autonomous Slack Trading Desk");
    expect(content).toContain("Real-Time Voice Architecture");
    expect(content).toContain("Persistent Distributed SQLite");
    expect(content).toContain("Securely Configured");
  });

  it("ScheduledOptionsManager and ScheduleFormModal express persistent background timers", () => {
    const manager = read("src/client/ScheduledOptionsManager.tsx");
    expect(manager).not.toContain("Cloudflare Agents Durable Timers");
    expect(manager).not.toContain("Cloudflare Durable Object storage");
    expect(manager).toContain("Persistent Background Timers");
    expect(manager).toContain("server-side distributed state");

    const modal = read("src/client/scheduledOptionsManager/ScheduleFormModal.tsx");
    expect(modal).not.toContain("durable Cloudflare Agents SDK timer");
    expect(modal).toContain("autonomous persistent timer");
  });

  it("ETradeDynamicMenu.tsx and FossResearchHub.tsx express persistent ledgers", () => {
    const menu = read("src/client/ETradeDynamicMenu.tsx");
    expect(menu).not.toContain("Durable Objects + SQLite");
    expect(menu).toContain("Persistent Distributed SQLite");

    const foss = read("src/client/FossResearchHub.tsx");
    expect(foss).not.toContain("SQLite Durable Objects");
    expect(foss).toContain("persistent event ledger");
  });

  it("AgentChatTabContent.tsx, RevenueTab.tsx, and AdsTab.tsx present platform capabilities", () => {
    const chat = read("src/client/chat/AgentChatTabContent.tsx");
    expect(chat).not.toContain("Stateful Durable Object SQLite Session");
    expect(chat).not.toContain("Cloudflare Workers AI");
    expect(chat).not.toContain('>Workers AI<');
    expect(chat).toContain("Stateful Distributed Ledger Session");
    expect(chat).toContain("neural strategy intelligence");
    expect(chat).toContain('>Neural Strategy<');

    const rev = read("src/client/chat/tabs/RevenueTab.tsx");
    expect(rev).not.toContain("Durable Object ORM");
    expect(rev).not.toContain("powered by SQLite ORM");
    expect(rev).toContain("transactional database ORM");

    const ads = read("src/client/chat/tabs/AdsTab.tsx");
    expect(ads).not.toContain("Workers AI Vectorize Bundle");
    expect(ads).not.toContain("Cloudflare Platform");
  });

  it("PartnerDealsModal.tsx presents enterprise developer capabilities without vendor hosting names", () => {
    const deals = read("src/client/components/PartnerDealsModal.tsx");
    expect(deals).not.toContain('"Cloudflare Workers AI"');
    expect(deals).not.toContain('"Cloudflare AI Search"');
    expect(deals).not.toContain('"Durable Objects SQLite"');
    expect(deals).toContain("Neural Strategy Accelerators");
    expect(deals).toContain("Enterprise Vector Knowledge Engine");
    expect(deals).toContain("Distributed Transactional Ledger");
  });

  it("Options research modals and panels reference neural strategy rather than Workers AI", () => {
    const panel = read("src/client/options/OptionsResearchPanel.tsx");
    expect(panel).not.toContain("Workers AI LLM");
    expect(panel).not.toContain("Configured Workers AI model");
    expect(panel).not.toContain("powered by Cloudflare Durable Timers");

    const evalModal = read("src/client/options/LlmStrategyEvalModal.tsx");
    expect(evalModal).not.toContain("Workers AI LLM Evaluation");
    expect(evalModal).not.toContain("Workers AI Llama 3.3");

    const ideas = read("src/client/options/LlmOptionsIdeasPanel.tsx");
    expect(ideas).not.toContain("Analyzing chains with Workers AI…");

    const etapi = read("src/client/options/EtapiConfigModal.tsx");
    expect(etapi).not.toContain("Cloudflare Workers AI model is assigned");
  });
});
