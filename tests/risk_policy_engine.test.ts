import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUTOPILOT_LIMITS,
  attestVerdict,
  describeVerdict,
  evaluatePolicy,
  normalizeAutopilotLimits,
  verifyVerdictAttestation,
  type AutopilotAccountState,
  type AutopilotFlags,
  type AutopilotPolicyLimits,
  type OrderIntent,
} from "../src/services/riskPolicyEngine";
import { mapAuditLogToAutonomousAction } from "../src/client/components/AutopilotControlCenter";

/**
 * Enforcement tests for the autopilot policy envelope (autopilot Phase 1).
 *
 * These assert the decision itself — the boundary values, the binding rule, and
 * the paused/blocked semantics — not the shape of a UI object. Before this
 * patch the only "policy check" test was a `Math.random()`-based simulation.
 */

const limits = (over: Partial<AutopilotPolicyLimits> = {}): AutopilotPolicyLimits =>
  normalizeAutopilotLimits({ ...DEFAULT_AUTOPILOT_LIMITS, ...over });

const account = (over: Partial<AutopilotAccountState> = {}): AutopilotAccountState => ({
  equity: 100_000,
  cash: 25_000,
  openNotional: 40_000,
  positionNotionalForSymbol: 0,
  ordersToday: 0,
  peakEquity: 100_000,
  asOf: "2026-10-15T14:00:00.000Z",
  ...over,
});

const flags = (over: Partial<AutopilotFlags> = {}): AutopilotFlags => ({
  running: true,
  killSwitch: false,
  killSwitchReason: null,
  ...over,
});

const buy = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  symbol: "NVDA",
  action: "BUY",
  quantity: 10,
  orderType: "MARKET",
  estimatedPrice: 100,
  estimatedTotal: 1_000,
  ...over,
});

const evaluate = (
  over: Partial<OrderIntent> = {},
  state: AutopilotAccountState = account(),
  envelope: AutopilotPolicyLimits = limits(),
  autopilot: AutopilotFlags = flags()
) => evaluatePolicy({ intent: buy(over), limits: envelope, flags: autopilot, state });

describe("policy limits — defaults and normalization", () => {
  it("keeps the institutional defaults shown in the control center", () => {
    const d = normalizeAutopilotLimits(null);
    expect(d.maxPositionPct).toBe(10.0);
    expect(d.cashReservePct).toBe(5.0);
    expect(d.ordersPerDay).toBe(10);
    expect(d.drawdownAlertPct).toBe(20.0);
    expect(d.universe).toBe("Default large caps/ETFs");
    expect(d.riskProfile).toBe("moderate");
  });

  it("clamps out-of-range input instead of letting a typo widen the envelope", () => {
    const wide = normalizeAutopilotLimits({
      maxPositionPct: 500,
      cashReservePct: -10,
      ordersPerDay: 0,
      drawdownAlertPct: 99,
      riskProfile: "reckless",
    });
    expect(wide.maxPositionPct).toBe(100);
    expect(wide.cashReservePct).toBe(0);
    expect(wide.ordersPerDay).toBe(1);
    expect(wide.drawdownAlertPct).toBe(90);
    expect(wide.riskProfile).toBe("moderate");
  });

  it("sanitizes the universe allowlist", () => {
    const cleaned = normalizeAutopilotLimits({ universeSymbols: [" spy ", "SPY", "qqq", ""] as string[] });
    expect(cleaned.universeSymbols).toEqual(["SPY", "QQQ"]);
  });
});

describe("envelope — passing case", () => {
  it("allows an in-envelope buy while running, with no finding bound", () => {
    const v = evaluate();
    expect(v.passed).toBe(true);
    expect(v.executionAllowed).toBe(true);
    expect(v.requiresApproval).toBe(false);
    expect(v.bindingRule).toBeNull();
    expect(v.mode).toBe("autonomous");
    expect(v.projections.positionPctOfNav).toBeCloseTo(1.0, 6);
  });

  it("names the binding constraint on a pass so the ledger row explains itself", () => {
    expect(describeVerdict(evaluate())).toBe("Max position (1.00%) ≤ 10.00%");
  });
});

describe("envelope — max position", () => {
  it("allows exposure exactly at the cap", () => {
    const v = evaluate({ estimatedTotal: 100 }, account({ positionNotionalForSymbol: 9_900 }));
    expect(v.projections.positionPctOfNav).toBeCloseTo(10.0, 6);
    expect(v.passed).toBe(true);
  });

  it("blocks exposure above the cap and reports max-position", () => {
    const v = evaluate({ estimatedTotal: 100 }, account({ positionNotionalForSymbol: 9_950 }));
    expect(v.passed).toBe(false);
    expect(v.bindingRule).toBe("max-position");
    expect(v.executionAllowed).toBe(false);
    expect(describeVerdict(v)).toContain("max-position");
  });

  it("counts the existing position, not just the new order", () => {
    const v = evaluate({ estimatedTotal: 500 }, account({ positionNotionalForSymbol: 9_800 }));
    expect(v.bindingRule).toBe("max-position");
  });
});

describe("envelope — orders per day", () => {
  it("allows the last order of the daily budget", () => {
    const v = evaluate({}, account({ ordersToday: 9 }));
    expect(v.passed).toBe(true);
    expect(v.projections.ordersToday).toBe(9);
  });

  it("blocks the order after the budget is spent", () => {
    const v = evaluate({}, account({ ordersToday: 10 }));
    expect(v.bindingRule).toBe("orders-per-day");
    expect(v.executionAllowed).toBe(false);
  });
});

describe("envelope — drawdown alert", () => {
  it("stops adding risk once drawdown reaches the alert threshold", () => {
    const v = evaluate({}, account({ equity: 80_000, peakEquity: 100_000 }));
    expect(v.projections.drawdownPct).toBeCloseTo(20.0, 6);
    expect(v.bindingRule).toBe("drawdown-alert");
  });

  it("stays silent below the threshold", () => {
    const v = evaluate({}, account({ equity: 85_000, peakEquity: 100_000 }));
    expect(v.projections.drawdownPct).toBeCloseTo(15.0, 6);
    expect(v.passed).toBe(true);
  });

  it("ignores drawdown when no peak has ever been sampled", () => {
    const v = evaluate({}, account({ peakEquity: null }));
    expect(v.projections.drawdownPct).toBeNull();
    expect(v.passed).toBe(true);
  });
});

describe("envelope — cash reserve", () => {
  it("blocks a buy that would breach the reserve", () => {
    const v = evaluate({ estimatedTotal: 200 }, account({ cash: 5_100 }));
    expect(v.projections.cashPctOfNavAfterFill).toBeCloseTo(4.9, 6);
    expect(v.bindingRule).toBe("cash-reserve");
  });

  it("does not apply the reserve to sell-side intents", () => {
    const v = evaluate({ action: "SELL", estimatedTotal: 5_000 }, account({ cash: 100 }));
    expect(v.bindingRule).toBeNull();
  });

  it("checks the reserve only after a fill, not before", () => {
    const v = evaluate({ estimatedTotal: 100 }, account({ cash: 5_000 }));
    expect(v.projections.cashPctOfNavAfterFill).toBeCloseTo(4.9, 6);
    expect(v.bindingRule).toBe("cash-reserve");
  });
});

describe("envelope — kill switch and paused routing", () => {
  it("blocks every intent while the kill switch is active, even a clean one", () => {
    const v = evaluate({}, account(), limits(), flags({ killSwitch: true, killSwitchReason: "risk team" }));
    expect(v.bindingRule).toBe("kill-switch");
    expect(v.executionAllowed).toBe(false);
    expect(describeVerdict(v)).toBe("Blocked: platform kill switch tripped");
  });

  it("routes to human approval when paused instead of claiming policy failure", () => {
    const v = evaluate({}, account(), limits(), flags({ running: false }));
    expect(v.mode).toBe("hitl");
    expect(v.passed).toBe(true);
    expect(v.executionAllowed).toBe(true);
    expect(v.requiresApproval).toBe(true);
    expect(v.bindingRule).toBe("autopilot-paused");
    expect(describeVerdict(v)).toBe("Autopilot paused — routed to human approval");
  });

  it("keeps a paused failure advisory rather than blocking the human", () => {
    const v = evaluate({ estimatedTotal: 50_000 }, account(), limits(), flags({ running: false }));
    expect(v.bindingRule).toBe("max-position");
    expect(v.executionAllowed).toBe(true); // the human authorizer still decides
    expect(v.requiresApproval).toBe(true);
  });
});

describe("envelope — insufficient data fails closed", () => {
  it("blocks autonomous execution when per-symbol exposure is unknown", () => {
    const v = evaluate({}, account({ positionNotionalForSymbol: null }));
    expect(v.bindingRule).toBe("insufficient-data");
    expect(v.executionAllowed).toBe(false);
  });

  it("blocks autonomous execution when equity is unknown", () => {
    const v = evaluate({}, account({ equity: null }));
    expect(v.bindingRule).toBe("insufficient-data");
    expect(v.executionAllowed).toBe(false);
  });

  it("treats missing data as advisory when a human is authorizing", () => {
    const v = evaluate({}, account({ equity: null }), limits(), flags({ running: false }));
    expect(v.executionAllowed).toBe(true);
    expect(v.findings.some((f) => f.ruleId === "insufficient-data" && f.severity === "info")).toBe(true);
  });
});

describe("envelope — universe allowlist", () => {
  it("blocks a symbol outside a configured allowlist", () => {
    const v = evaluate({}, account(), limits({ universeSymbols: ["SPY", "QQQ"] }));
    expect(v.bindingRule).toBe("outside-universe");
  });

  it("allows a symbol inside the allowlist", () => {
    const v = evaluate({ symbol: "SPY" }, account(), limits({ universeSymbols: ["SPY", "QQQ"] }));
    expect(v.bindingRule).toBeNull();
  });

  it("does not pretend to enforce the cosmetic label when no list is set", () => {
    const v = evaluate({ symbol: "ANYTHING" }, account(), limits({ universeSymbols: null }));
    expect(v.bindingRule).toBeNull();
  });
});

describe("determinism and identity", () => {
  const now = new Date("2026-10-15T14:30:00.000Z");

  it("produces the same verdictId for identical inputs", () => {
    const a = evaluatePolicy({ intent: buy(), limits: limits(), flags: flags(), state: account(), now });
    const b = evaluatePolicy({ intent: buy(), limits: limits(), flags: flags(), state: account(), now });
    expect(a.verdictId).toBe(b.verdictId);
  });

  it("changes the verdictId when the intent changes", () => {
    const a = evaluatePolicy({ intent: buy(), limits: limits(), flags: flags(), state: account(), now });
    const b = evaluatePolicy({ intent: buy({ quantity: 11 }), limits: limits(), flags: flags(), state: account(), now });
    expect(a.verdictId).not.toBe(b.verdictId);
  });

  it("carries the dry-run flag through to the verdict", () => {
    const v = evaluatePolicy({ intent: buy(), limits: limits(), flags: flags(), state: account(), dryRun: true, now });
    expect(v.dryRun).toBe(true);
  });
});

describe("attestation — signed where the decision is made", () => {
  const signingKey = "test-signing-key-placeholder";

  it("signs a verdict and verifies it", async () => {
    const v = evaluate();
    const attestation = await attestVerdict(v, { signingKey });
    expect(attestation.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(attestation.alg).toBe("HmacSha256");
    expect(attestation.proposerDid).toBe("did:agent:openaimp:trading");
    expect(await verifyVerdictAttestation(v, attestation, signingKey)).toBe(true);
  });

  it("rejects a tampered verdict", async () => {
    const v = evaluate();
    const attestation = await attestVerdict(v, { signingKey });
    const tampered = { ...v, intents: { ...v.intents, quantity: 9_999 } };
    expect(await verifyVerdictAttestation(tampered, attestation, signingKey)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const v = evaluate();
    const attestation = await attestVerdict(v, { signingKey });
    expect(await verifyVerdictAttestation(v, attestation, "another-signing-key")).toBe(false);
  });

  it("refuses to sign with a trivial key", async () => {
    await expect(attestVerdict(evaluate(), { signingKey: "short" })).rejects.toThrow();
  });

  it("marks the authorizer as the orchestrator only while autopilot is running", async () => {
    const running = await attestVerdict(evaluate(), { signingKey, authorizerDid: "did:agent:openaimp:orchestrator" });
    const paused = await attestVerdict(evaluate({}, account(), limits(), flags({ running: false })), { signingKey });
    expect(running.authorizerDid).toBe("did:agent:openaimp:orchestrator");
    expect(paused.authorizerDid).toBe("did:user:pending-human-authorization");
  });
});

describe("audit ledger mapping — no fabricated signatures", () => {
  it("maps a server-signed verdict row with its real signature", () => {
    const mapped = mapAuditLogToAutonomousAction({
      id: "evt-verdict-1",
      type: "autopilot.policy_verdict",
      agent: "trading",
      payload: {
        symbol: "NVDA",
        policyCheckRule: "Max position (1.00%) ≤ 10.00%",
        policyCheckPassed: true,
        status: "verified",
        proposerDid: "did:agent:openaimp:trading",
        proofSignature: "a".repeat(64),
      },
      created_at: "2026-10-15T14:30:00.000Z",
    });
    expect(mapped.didAttestation.signature).toBe("a".repeat(64));
    expect(mapped.policyCheckPassed).toBe(true);
  });

  it("leaves an unsigned row unsigned instead of inventing a signature", () => {
    const mapped = mapAuditLogToAutonomousAction({
      id: "evt-unsigned-1",
      type: "autopilot.policy_verdict",
      agent: "trading",
      payload: { symbol: "NVDA", policyCheckRule: "no signature recorded" },
      created_at: "2026-10-15T14:31:00.000Z",
    });
    expect(mapped.didAttestation.signature).toBe("");
  });
});
