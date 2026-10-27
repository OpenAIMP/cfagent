import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #680: ReportAssetAgent helpers.
 * The DO class itself needs the Cloudflare runtime; these tests cover the
 * pure helpers. The DO is exercised in integration.
 *
 * #1958: the class extends PortThink, whose runtime import graph
 * (@cloudflare/think) needs workerd schemes the node vitest harness
 * cannot load (see src/actors/thinkPortMapping.ts header). The Think
 * base is therefore stubbed here — exactly the idiom this file
 * already uses for "agents" — while the source-evidence tests below
 * pin the REAL production import graph (PortThink from the adapter,
 * never a direct @cloudflare/think import).
 */

vi.mock("agents", () => ({
  Agent: class {},
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {},
}));

vi.mock("../src/services/unifiedReportPipeline", () => ({
  generateReportPdf: async (_type: string, data: unknown) => {
    if ((data as { boom?: boolean } | null)?.boom) throw new Error("render boom");
    return new Uint8Array([9, 8, 7]);
  },
  getReportFileName: async (type: string) => `${type}-report.pdf`,
}));

describe("#680 report asset agent", () => {
  it("namespaces agent names per user", async () => {
    const { reportAssetAgentName } = await import("../src/agents/report-asset-agent");
    // Issue #1185: the bare "default" name belongs to the configured
    // service identity only — never to a literal login.
    expect(reportAssetAgentName("svc-reports", "svc-reports")).toBe("default");
    expect(reportAssetAgentName("alice", "svc-reports")).toBe("assets:alice");
    expect(reportAssetAgentName("alice")).toBe("assets:alice");
    expect(reportAssetAgentName("default_trader")).toBe("assets:default_trader");
  });

  it("generatePdfAsset returns null without the binding (no throw)", async () => {
    const { generatePdfAsset } = await import("../src/agents/report-asset-agent");
    const result = await generatePdfAsset({}, "alice", "research", {});
    expect(result).toBeNull();
  });

  it("generatePdfAssetWithBytes returns null without the binding", async () => {
    const { generatePdfAssetWithBytes } = await import("../src/agents/report-asset-agent");
    const result = await generatePdfAssetWithBytes({}, "alice", "options", {});
    expect(result).toBeNull();
  });

  it("getPdfAsset returns null without the binding", async () => {
    const { getPdfAsset } = await import("../src/agents/report-asset-agent");
    const result = await getPdfAsset({}, "alice", "some-key");
    expect(result).toBeNull();
  });
});

describe("#1958 report asset agent migrates to PortThink", () => {
  const src = () =>
    readFileSync(join(__dirname, "../src/agents/report-asset-agent.ts"), "utf8");

  it("extends PortThink from the adapter, never raw Think or Agent", () => {
    const text = src();
    expect(text).toMatch(/export\s+class\s+ReportAssetAgent\s+extends\s+PortThink\b/);
    expect(text).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(text).not.toContain('from "@cloudflare/think"');
    expect(text).not.toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    // The RPC surface is untouched by the migration.
    expect(text).toContain("async generateAsset(");
    expect(text).toContain("async getAsset(");
  });

  it("inherits PortThink statically (prototype chain, no DO runtime needed)", async () => {
    const { ReportAssetAgent } = await import("../src/agents/report-asset-agent");
    const { PortThink } = await import("../src/actors/thinkAdapter");
    expect(Object.getPrototypeOf(ReportAssetAgent)).toBe(PortThink);
    expect(Object.create(ReportAssetAgent.prototype)).toBeInstanceOf(PortThink);
    expect(typeof ReportAssetAgent.prototype.generateAsset).toBe("function");
    expect(typeof ReportAssetAgent.prototype.getAsset).toBe("function");
  });

  /** Constructor-free instance: the DO constructor needs workerd ctx. */
  async function bareInstance() {
    const { ReportAssetAgent } = await import("../src/agents/report-asset-agent");
    const inst = Object.create(ReportAssetAgent.prototype) as any;
    const store = new Map<string, unknown>();
    inst.ctx = {
      storage: {
        put: async (k: string, v: unknown) => {
          store.set(k, v);
        },
        get: async (k: string) => store.get(k) ?? null,
      },
    };
    inst.env = {};
    return inst;
  }

  it("generateAsset + getAsset round-trip through DO storage under PortThink", async () => {
    const inst = await bareInstance();
    const result = await inst.generateAsset({ type: "research", data: {} });
    expect(result).not.toBeNull();
    expect(result.fileName).toBe("research-report.pdf");
    expect(result.key).toMatch(/^report:pdf:research:[0-9a-f-]{8}$/);
    const back = await inst.getAsset(result.key);
    expect(back).not.toBeNull();
    expect(back.fileName).toBe("research-report.pdf");
    expect(Array.from(back.bytes)).toEqual([9, 8, 7]);
  });

  it("generateAsset still returns null (never throws) when rendering fails", async () => {
    const inst = await bareInstance();
    await expect(inst.generateAsset({ type: "screener", data: { boom: true } })).resolves.toBeNull();
  });

  describe("Think turn path inherited from PortThink (adapter protocol)", () => {
    async function bareWithHooks(hooks: any) {
      const inst = await bareInstance();
      inst.portHooks = hooks;
      return inst;
    }

    const thinkCtx = () => ({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      model: { modelId: "test-model" },
      continuation: false,
      body: {},
    });

    it("one-shot override returns without delegating to port hooks, exactly once", async () => {
      const seen: unknown[] = [];
      const inst = await bareWithHooks({
        beforeTurn: async (ctx: unknown) => {
          seen.push(ctx);
          return { instructions: "from hooks" };
        },
      });
      inst.setPortTurnOverride({ instructions: "one-shot" });
      expect(await inst.beforeTurn(thinkCtx())).toEqual({ instructions: "one-shot" });
      expect(seen).toHaveLength(0);
      // The override is consumed: the next turn delegates again.
      expect(await inst.beforeTurn(thinkCtx())).toEqual({ instructions: "from hooks" });
      expect(seen).toHaveLength(1);
    });

    it("direct turns delegate beforeTurn once, with the port-mapped context", async () => {
      const seen: any[] = [];
      const inst = await bareWithHooks({
        beforeTurn: async (ctx: any) => {
          seen.push(ctx);
          return { instructions: "do it", maxSteps: 2 };
        },
      });
      expect(await inst.beforeTurn(thinkCtx())).toEqual({ instructions: "do it", maxSteps: 2 });
      expect(seen).toHaveLength(1);
      expect(seen[0].system).toBe("sys");
      expect(seen[0].messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("onChatResponse records during adapter turns and flushes only after", async () => {
      const responses: any[] = [];
      const inst = await bareWithHooks({
        onChatResponse: async (r: any) => {
          responses.push(r);
        },
      });
      const thinkResult = {
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      };
      inst.beginAdapterTurn();
      await inst.onChatResponse(thinkResult);
      expect(inst.lastThinkResponse).toBe(thinkResult);
      expect(responses).toHaveLength(0);
      inst.endAdapterTurn();
      await inst.onChatResponse(thinkResult);
      expect(responses).toHaveLength(1);
      expect(responses[0].status).toBe("completed");
      expect(responses[0].message.parts).toEqual([{ type: "text", text: "hello" }]);
    });

    it("onChatError is synchronous: a string hook controls the error text", async () => {
      const inst = await bareWithHooks({
        onChatError: (err: unknown) => `friendly: ${(err as Error).message}`,
      });
      expect(inst.onChatError(new Error("provider down"))).toBe("friendly: provider down");
      inst.beginAdapterTurn();
      inst.onChatError(new Error("provider down"));
      expect(inst.adapterTurnErrorReported).toBe(true);
      inst.endAdapterTurn();
    });

    it("with no port hooks, beforeTurn is void and onChatError passes the error through", async () => {
      const inst = await bareInstance();
      expect(await inst.beforeTurn(thinkCtx())).toBeUndefined();
      const err = new Error("raw");
      expect(inst.onChatError(err)).toBe(err);
    });
  });
});
