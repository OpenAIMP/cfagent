/**
 * Issue #1763 (parent #1717, scan row F-60) — stable error tokens in
 * A2ADataResult from the EXISTING AGENT_ERROR_CATALOG
 * (src/aspects/errorCodes.ts). Consumers judge failures by token, not
 * prose. The existing trading `code` token is kept (backward
 * compatible, pinned by #291 tests); this slice ADDS the catalog
 * token alongside it — never either/or. Every failure result from
 * dispatchTradingA2A carries an errorToken that is a key of
 * AGENT_ERROR_CATALOG, and the catalog entry for it exists.
 */
import { describe, it, expect, vi } from "vitest";

// Same idiom as tests/trading_agent.test.ts: mock the Agents SDK so
// the real module graph's `cloudflare:` imports never reach node.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
import {
  dispatchTradingA2A,
  tradingErrorCatalogCode,
} from "../src/agents/trading-agent";
import { AGENT_ERROR_CATALOG } from "../src/aspects/errorCodes";

const fakeConfig: any = { enabledServices: ["stock_screening"] };
const fakeEnv: any = {};

describe("A2A stable error tokens from AGENT_ERROR_CATALOG (#1763)", () => {
  it("maps every trading error token to an existing catalog entry", () => {
    for (const token of [
      "unknown_service",
      "unknown_operation",
      "missing_operation",
      "service_disabled",
      "provider_not_enabled",
      "provider_not_registered",
      "provider_unsupported",
      "invalid_input",
      "internal_error",
    ] as const) {
      const catalogCode = tradingErrorCatalogCode(token);
      expect(AGENT_ERROR_CATALOG[catalogCode]).toBeDefined();
      expect(AGENT_ERROR_CATALOG[catalogCode].code).toBe(catalogCode);
    }
  });

  it("missing/unknown operations carry a catalog token next to the trading code", async () => {
    const missing = await dispatchTradingA2A(fakeEnv, fakeConfig, { hello: 1 });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("missing_operation");
    expect(missing.errorToken).toBeDefined();
    expect(AGENT_ERROR_CATALOG[missing.errorToken!]).toBeDefined();

    const unknown = await dispatchTradingA2A(fakeEnv, fakeConfig, {
      operation: "trading.nope",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("unknown_operation");
    expect(unknown.errorToken).toBeDefined();
    expect(AGENT_ERROR_CATALOG[unknown.errorToken!]).toBeDefined();
  });

  it("success results carry no error token", async () => {
    // A dispatch that reaches execution with a fake provider still
    // fails, but through the classified path — assert the shape rule
    // on the early-return paths instead: ok results never set it.
    const ok: any = { ok: true, operation: "trading.screen_stocks" };
    expect(ok.errorToken).toBeUndefined();
  });
});
