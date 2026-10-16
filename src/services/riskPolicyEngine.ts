/**
 * Autopilot Risk Policy Engine — the deterministic policy envelope behind the
 * Autopilot Control Center claim "Enforced at runtime by RiskPolicyEngine &
 * W3C Agent DID".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this module, the control center's policy limits (max position, cash
 * reserve, orders/day, drawdown alert) lived only as React state and a
 * `Math.random() > 0.15` "policy check" in the browser. No order path consumed
 * them, and the label naming a "RiskPolicyEngine" referred to nothing. This
 * module is that engine, and it is the only place order-side policy is decided.
 *
 * THE ENVELOPE (evaluated in order, first failing rule becomes bindingRule)
 * -----------------------------------------------------------------------
 *   1. kill-switch        — platform kill switch tripped
 *   2. autopilot-paused   — running=false routes ideas to human approval
 *   3. insufficient-data  — cannot verify the envelope ⇒ no autonomous pass
 *   4. drawdown-alert     — peak-to-trough drawdown at or beyond the alert
 *   5. orders-per-day     — broker submissions used up for the day
 *   6. max-position       — projected single-name exposure of NAV
 *   7. cash-reserve       — projected cash after a buy
 *   8. outside-universe   — symbol outside the configured universe allowlist
 *
 * MODES
 * -----
 * `autonomous` — autopilot is running. Every rule is a hard gate.
 * `hitl`       — autopilot is paused. Findings are advisory: a human is the
 *                authorizer, so `executionAllowed` stays true and the verdict
 *                is recorded to the ledger as evidence of what was checked.
 *
 * This mirrors the product copy: "Pausing sends new ideas to approval instead."
 * It never grants autonomous execution — `/etrade/order/execute` keeps its
 * strict HITL gate (`did:agent:*` callers are refused).
 *
 * Determinism: `evaluatePolicy` is pure. Same inputs ⇒ same verdict, same
 * `verdictId`. No IO, no clock beyond the injected `now`, no randomness.
 */

export type RiskProfile = "conservative" | "moderate" | "aggressive";

/** The live policy limits. Canonical definition — client and server both use this. */
export interface AutopilotPolicyLimits {
  /** Max single-name exposure as % of account equity. */
  maxPositionPct: number;
  /** Minimum cash as % of equity that must remain after any buy. */
  cashReservePct: number;
  /** Max broker submissions per trading day while autopilot is running. */
  ordersPerDay: number;
  /** Peak-to-trough drawdown %, at which autopilot must stop adding risk. */
  drawdownAlertPct: number;
  /** Human-readable universe label (shown in the UI). */
  universe: string;
  riskProfile: RiskProfile;
  /**
   * Optional explicit allowlist backing the universe label. When present (and
   * non-empty) it is enforced; when absent the label is cosmetic and
   * `outside-universe` never fires.
   */
  universeSymbols?: string[] | null;
}

/** Institutional defaults shown in the control center. */
export const DEFAULT_AUTOPILOT_LIMITS: AutopilotPolicyLimits = {
  maxPositionPct: 10.0,
  cashReservePct: 5.0,
  ordersPerDay: 10,
  drawdownAlertPct: 20.0,
  universe: "Default large caps/ETFs",
  riskProfile: "moderate",
  universeSymbols: null,
};

export const POLICY_LIMIT_BOUNDS = {
  maxPositionPct: { min: 0.5, max: 100 },
  cashReservePct: { min: 0, max: 90 },
  ordersPerDay: { min: 1, max: 200 },
  drawdownAlertPct: { min: 1, max: 90 },
} as const;

/** Autopilot run state + kill switch, owned by the Durable Object. */
export interface AutopilotFlags {
  running: boolean;
  killSwitch: boolean;
  killSwitchReason?: string | null;
}

/** Canonical, already-normalized limits. */
export function defaultLimits(): AutopilotPolicyLimits {
  return { ...DEFAULT_AUTOPILOT_LIMITS };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function coerceNumber(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalizes untrusted (client-supplied) limits into a valid envelope.
 * Out-of-range values are clamped rather than rejected so a typo cannot widen
 * the envelope silently, and `universeSymbols` is sanitized to upper-case
 * tickers with duplicates removed.
 */
export function normalizeAutopilotLimits(
  input: Partial<AutopilotPolicyLimits> | null | undefined
): AutopilotPolicyLimits {
  const raw = input ?? {};
  const profile = String(raw.riskProfile ?? DEFAULT_AUTOPILOT_LIMITS.riskProfile).toLowerCase();
  const riskProfile: RiskProfile =
    profile === "conservative" || profile === "aggressive" || profile === "moderate"
      ? (profile as RiskProfile)
      : "moderate";

  const symbols = Array.isArray(raw.universeSymbols)
    ? Array.from(
        new Set(
          raw.universeSymbols
            .map((s) => String(s ?? "").trim().toUpperCase())
            .filter((s) => s.length > 0 && s.length <= 12)
        )
      )
    : null;

  return {
    maxPositionPct: clamp(
      coerceNumber(raw.maxPositionPct, DEFAULT_AUTOPILOT_LIMITS.maxPositionPct),
      POLICY_LIMIT_BOUNDS.maxPositionPct.min,
      POLICY_LIMIT_BOUNDS.maxPositionPct.max
    ),
    cashReservePct: clamp(
      coerceNumber(raw.cashReservePct, DEFAULT_AUTOPILOT_LIMITS.cashReservePct),
      POLICY_LIMIT_BOUNDS.cashReservePct.min,
      POLICY_LIMIT_BOUNDS.cashReservePct.max
    ),
    ordersPerDay: Math.round(
      clamp(
        coerceNumber(raw.ordersPerDay, DEFAULT_AUTOPILOT_LIMITS.ordersPerDay),
        POLICY_LIMIT_BOUNDS.ordersPerDay.min,
        POLICY_LIMIT_BOUNDS.ordersPerDay.max
      )
    ),
    drawdownAlertPct: clamp(
      coerceNumber(raw.drawdownAlertPct, DEFAULT_AUTOPILOT_LIMITS.drawdownAlertPct),
      POLICY_LIMIT_BOUNDS.drawdownAlertPct.min,
      POLICY_LIMIT_BOUNDS.drawdownAlertPct.max
    ),
    universe:
      String(raw.universe ?? DEFAULT_AUTOPILOT_LIMITS.universe).slice(0, 80) || DEFAULT_AUTOPILOT_LIMITS.universe,
    riskProfile,
    universeSymbols: symbols && symbols.length > 0 ? symbols : null,
  };
}

/**
 * Account + book state the envelope is evaluated against.
 * Every field is `null` when unknown — unknown must never read as safe.
 */
export interface AutopilotAccountState {
  /** Total account equity (NAV). */
  equity: number | null;
  /** Settled/available cash. */
  cash: number | null;
  /** Sum of open position notional (all names). */
  openNotional: number | null;
  /** Open notional for the candidate's symbol only. */
  positionNotionalForSymbol: number | null;
  /** Broker submissions already made today while autopilot was running. */
  ordersToday: number;
  /** Highest equity observed (for drawdown); null when never sampled. */
  peakEquity: number | null;
  /** When equity was observed, for staleness checks. */
  asOf: string | null;
}

export interface OrderIntent {
  symbol: string;
  /** BUY-side intents consume cash; SELL-side intents free it. */
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT" | string;
  quantity: number;
  orderType?: string;
  /** Per-share estimate (limit price, or last/estimated price). */
  estimatedPrice: number | null;
  /** Total notional; falls back to quantity × estimatedPrice when null. */
  estimatedTotal: number | null;
}

export type PolicyRuleId =
  | "kill-switch"
  | "autopilot-paused"
  | "insufficient-data"
  | "drawdown-alert"
  | "orders-per-day"
  | "max-position"
  | "cash-reserve"
  | "outside-universe";

export interface PolicyFinding {
  ruleId: PolicyRuleId;
  severity: "block" | "approval" | "info";
  detail: string;
  observed: string | null;
  threshold: string | null;
}

export interface PolicyVerdict {
  verdictId: string;
  /** True when every applicable rule was satisfied with known inputs. */
  passed: boolean;
  /** False when the order must not proceed in the current mode. */
  executionAllowed: boolean;
  /** True when a human must authorize before this intent proceeds. */
  requiresApproval: boolean;
  /**
   * The rule that decided the outcome: the first blocking rule in evaluation
   * order, or the approval-routing rule when autopilot is paused and nothing
   * blocked. Null when the envelope passed cleanly.
   */
  bindingRule: PolicyRuleId | null;
  detail: string;
  mode: "autonomous" | "hitl";
  dryRun: boolean;
  findings: PolicyFinding[];
  intents: {
    symbol: string;
    action: string;
    quantity: number;
    notional: number | null;
  };
  projections: {
    positionPctOfNav: number | null;
    cashPctOfNavAfterFill: number | null;
    drawdownPct: number | null;
    ordersToday: number;
  };
  limits: AutopilotPolicyLimits;
  evaluatedAt: string;
}

export interface EvaluatePolicyParams {
  intent: OrderIntent;
  limits: AutopilotPolicyLimits;
  flags: AutopilotFlags;
  state: AutopilotAccountState;
  /** Overrides the mode the flags imply; used by the dry-run endpoint. */
  mode?: "autonomous" | "hitl";
  dryRun?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
}

const BUY_SIDE = new Set(["BUY", "BUY_TO_COVER"]);

function pct(numerator: number, denominator: number): number {
  return (numerator / denominator) * 100;
}

function fmtPct(value: number | null, digits = 2): string | null {
  return value === null ? null : `${value.toFixed(digits)}%`;
}

function intentNotional(intent: OrderIntent): number | null {
  if (typeof intent.estimatedTotal === "number" && Number.isFinite(intent.estimatedTotal)) {
    return Math.abs(intent.estimatedTotal);
  }
  if (
    typeof intent.estimatedPrice === "number" &&
    Number.isFinite(intent.estimatedPrice) &&
    Number.isFinite(intent.quantity)
  ) {
    return Math.abs(intent.estimatedPrice * intent.quantity);
  }
  return null;
}

/**
 * Stable identifier for a verdict's inputs. FNV-1a over a canonical string —
 * an identity/dedupe key, NOT a security primitive (see attestVerdict).
 */
function verdictIdFor(canonical: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `pol_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Evaluates the autopilot policy envelope for a single order intent.
 * Pure and deterministic: identical inputs yield an identical verdict.
 */
export function evaluatePolicy(params: EvaluatePolicyParams): PolicyVerdict {
  const { intent, limits, flags, state } = params;
  const now = params.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const mode: "autonomous" | "hitl" = params.mode ?? (flags.running ? "autonomous" : "hitl");
  const dryRun = Boolean(params.dryRun);

  const notional = intentNotional(intent);
  const isBuy = BUY_SIDE.has(String(intent.action).toUpperCase());

  const equity = state.equity;
  const cash = state.cash;
  const symbolNotional = state.positionNotionalForSymbol;

  const positionAfter =
    equity !== null && notional !== null && symbolNotional !== null ? symbolNotional + notional : null;
  const positionPctOfNav = positionAfter !== null && equity ? pct(positionAfter, equity) : null;

  const cashAfterFill = cash !== null && notional !== null && isBuy ? cash - notional : cash;
  const cashPctOfNavAfterFill = cashAfterFill !== null && equity ? pct(cashAfterFill, equity) : null;

  const drawdownPct =
    state.peakEquity !== null && equity !== null && state.peakEquity > 0
      ? Math.max(0, pct(state.peakEquity - equity, state.peakEquity))
      : null;

  const findings: PolicyFinding[] = [];

  // 1. Kill switch — platform-level stop, always a hard block.
  if (flags.killSwitch) {
    findings.push({
      ruleId: "kill-switch",
      severity: "block",
      detail: `Platform kill switch is active${flags.killSwitchReason ? `: ${flags.killSwitchReason}` : ""}.`,
      observed: "active",
      threshold: "inactive",
    });
  }

  // 2. Paused — allowed, but only with human authorization.
  if (!flags.running) {
    findings.push({
      ruleId: "autopilot-paused",
      severity: "approval",
      detail: "Autopilot is paused; this idea routes to human approval instead of autonomous execution.",
      observed: "paused",
      threshold: "running",
    });
  }

  // 3. Insufficient data — fail closed for autonomous execution.
  const missing: string[] = [];
  if (equity === null || equity <= 0) missing.push("account equity");
  if (notional === null || notional <= 0) missing.push("order notional (price/quantity)");
  if (isBuy && cash === null) missing.push("available cash");
  if (symbolNotional === null) missing.push(`open exposure for ${intent.symbol || "symbol"}`);
  if (missing.length > 0) {
    findings.push({
      ruleId: "insufficient-data",
      severity: mode === "autonomous" ? "block" : "info",
      detail: `Cannot verify the policy envelope: missing ${missing.join(", ")}.`,
      observed: null,
      threshold: "complete account state",
    });
  }

  // 4. Drawdown alert — the book is already past its pain threshold.
  if (drawdownPct !== null && drawdownPct >= limits.drawdownAlertPct) {
    findings.push({
      ruleId: "drawdown-alert",
      severity: "block",
      detail: `Drawdown ${drawdownPct.toFixed(2)}% has reached the ${limits.drawdownAlertPct.toFixed(
        2
      )}% alert threshold; autopilot must stop adding risk.`,
      observed: fmtPct(drawdownPct),
      threshold: fmtPct(limits.drawdownAlertPct),
    });
  }

  // 5. Orders per day — counted on broker submissions, not ideas.
  if (state.ordersToday >= limits.ordersPerDay) {
    findings.push({
      ruleId: "orders-per-day",
      severity: "block",
      detail: `Daily autonomous order budget used: ${state.ordersToday} of ${limits.ordersPerDay}.`,
      observed: String(state.ordersToday),
      threshold: String(limits.ordersPerDay),
    });
  }

  // 6. Max position — projected single-name exposure of NAV.
  if (positionPctOfNav !== null && positionPctOfNav > limits.maxPositionPct) {
    findings.push({
      ruleId: "max-position",
      severity: "block",
      detail: `Projected ${intent.symbol} exposure ${positionPctOfNav.toFixed(2)}% exceeds the ${limits.maxPositionPct.toFixed(
        2
      )}% cap.`,
      observed: fmtPct(positionPctOfNav),
      threshold: fmtPct(limits.maxPositionPct),
    });
  }

  // 7. Cash reserve — projected cash after a buy.
  if (isBuy && cashPctOfNavAfterFill !== null && cashPctOfNavAfterFill < limits.cashReservePct) {
    findings.push({
      ruleId: "cash-reserve",
      severity: "block",
      detail: `Cash after fill would be ${cashPctOfNavAfterFill.toFixed(2)}%, below the ${limits.cashReservePct.toFixed(
        2
      )}% reserve.`,
      observed: fmtPct(cashPctOfNavAfterFill),
      threshold: fmtPct(limits.cashReservePct),
    });
  }

  // 8. Universe allowlist — only enforced when an explicit list is configured.
  if (
    limits.universeSymbols &&
    limits.universeSymbols.length > 0 &&
    !limits.universeSymbols.includes(String(intent.symbol || "").toUpperCase())
  ) {
    findings.push({
      ruleId: "outside-universe",
      severity: "block",
      detail: `${intent.symbol} is outside the configured universe (${limits.universe}).`,
      observed: String(intent.symbol || "").toUpperCase(),
      threshold: limits.universe,
    });
  }

  const blocking = findings.find((f) => f.severity === "block") ?? null;
  const needsApproval = findings.some((f) => f.severity === "approval");
  const passed = blocking === null;
  // A paused autopilot never executes; a human authorizes. That is a routing
  // decision, not a policy failure, so `passed` stays true for the paused case.
  const executionAllowed = mode === "hitl" ? true : passed;
  const requiresApproval = !executionAllowed || needsApproval || mode === "hitl";

  const bindingRule: PolicyRuleId | null = blocking?.ruleId ?? (needsApproval ? "autopilot-paused" : null);
  const detail =
    blocking?.detail ??
    (needsApproval
      ? "All rules satisfied; routed to human approval because autopilot is paused."
      : "All policy rules satisfied.");

  const canonical = [
    intent.symbol.toUpperCase(),
    String(intent.action).toUpperCase(),
    String(intent.quantity),
    notional === null ? "na" : notional.toFixed(2),
    mode,
    dryRun ? "dry" : "live",
    flags.killSwitch ? "kill" : "ok",
    limits.maxPositionPct.toFixed(2),
    limits.cashReservePct.toFixed(2),
    String(limits.ordersPerDay),
    limits.drawdownAlertPct.toFixed(2),
    state.ordersToday,
    equity === null ? "na" : equity.toFixed(2),
    cash === null ? "na" : cash.toFixed(2),
    state.peakEquity === null ? "na" : state.peakEquity.toFixed(2),
  ].join("|");

  return {
    verdictId: verdictIdFor(canonical),
    passed,
    executionAllowed,
    requiresApproval,
    bindingRule,
    detail,
    mode,
    dryRun,
    findings,
    intents: {
      symbol: String(intent.symbol || "").toUpperCase(),
      action: String(intent.action || "").toUpperCase(),
      quantity: intent.quantity,
      notional,
    },
    projections: {
      positionPctOfNav,
      cashPctOfNavAfterFill,
      drawdownPct,
      ordersToday: state.ordersToday,
    },
    limits,
    evaluatedAt,
  };
}

/** Human-readable one-liner stored on each ledger row. */
export function describeVerdict(verdict: PolicyVerdict): string {
  if (verdict.passed && !verdict.requiresApproval) {
    const p = verdict.projections.positionPctOfNav;
    return p === null
      ? "Policy envelope satisfied"
      : `Max position (${p.toFixed(2)}%) ≤ ${verdict.limits.maxPositionPct.toFixed(2)}%`;
  }
  if (verdict.bindingRule === "autopilot-paused") {
    return "Autopilot paused — routed to human approval";
  }
  if (verdict.bindingRule === "kill-switch") {
    return "Blocked: platform kill switch tripped";
  }
  return verdict.bindingRule ? `Blocked: ${verdict.bindingRule} — ${verdict.detail}` : verdict.detail;
}

/** Fields covered by the attestation signature, in stable order. */
const ATTESTED_FIELDS = [
  "verdictId",
  "passed",
  "executionAllowed",
  "requiresApproval",
  "bindingRule",
  "mode",
  "dryRun",
  "evaluatedAt",
] as const;

export interface PolicyVerdictAttestation {
  alg: "HmacSha256";
  keyId: string;
  proposerDid: string;
  authorizerDid: string;
  signedAt: string;
  /** Lower-case hex HMAC over the canonical verdict payload. */
  signature: string;
}

export const POLICY_VERDICT_PROPOSER_DID = "did:agent:openaimp:trading";
export const POLICY_VERDICT_KEY_LABEL = "autopilot-verdict-v1";

function canonicalVerdictMessage(verdict: PolicyVerdict): string {
  const core: Record<string, unknown> = {};
  for (const field of ATTESTED_FIELDS) core[field] = (verdict as unknown as Record<string, unknown>)[field];
  return JSON.stringify({
    v: 1,
    engine: POLICY_VERDICT_KEY_LABEL,
    verdict: core,
    intents: verdict.intents,
    projections: verdict.projections,
    limits: verdict.limits,
  });
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function hmacKey(keyMaterial: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  // Derive a purpose-bound key so the platform credential is never used raw.
  const derived = await crypto.subtle.sign("HMAC", baseKey, enc.encode(POLICY_VERDICT_KEY_LABEL));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Server-side attestation for a verdict. The signature is produced where the
 * decision is made (Worker secret) — never in a browser — so a ledger row
 * cannot be forged by a client that simply writes `policyCheckPassed: true`.
 */
export async function attestVerdict(
  verdict: PolicyVerdict,
  options: { signingKey: string; authorizerDid?: string; proposerDid?: string }
): Promise<PolicyVerdictAttestation> {
  const { signingKey } = options;
  if (!signingKey || signingKey.length < 8) {
    throw new Error("attestVerdict requires a non-trivial signing key");
  }
  const key = await hmacKey(signingKey);
  const signature = toHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalVerdictMessage(verdict)))
  );
  return {
    alg: "HmacSha256",
    keyId: POLICY_VERDICT_KEY_LABEL,
    proposerDid: options.proposerDid ?? POLICY_VERDICT_PROPOSER_DID,
    authorizerDid: options.authorizerDid ?? "did:user:pending-human-authorization",
    signedAt: new Date().toISOString(),
    signature,
  };
}

/** Re-derives the signature; used by tests and by anyone auditing the ledger. */
export async function verifyVerdictAttestation(
  verdict: PolicyVerdict,
  attestation: Pick<PolicyVerdictAttestation, "signature">,
  signingKey: string
): Promise<boolean> {
  try {
    const key = await hmacKey(signingKey);
    const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalVerdictMessage(verdict)));
    return toHex(expected) === String(attestation.signature || "").toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Builds account state from whatever the broker/ORM actually returned, without
 * inventing numbers. Unknown stays null so the envelope fails closed.
 */
export function buildAccountStateFromBalance(
  balance: unknown,
  extras: { ordersToday?: number; peakEquity?: number | null; asOf?: string | null } = {}
): AutopilotAccountState {
  const b = (balance ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number | null => {
    for (const key of keys) {
      const v = b[key];
      const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : (v as number);
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
    return null;
  };

  const equity = num(
    "totalAccountValue",
    "netAccountValue",
    "accountValue",
    "totalEquity",
    "equity",
    "netLiquidationValue"
  );
  const cash = num("netCash", "cashBalance", "cashAvailableForInvestment", "totalCash", "availableCash");
  const longValue = num("longPositionsMarketValue", "longMarketValue", "positionsMarketValue", "marketValue");

  return {
    equity,
    cash,
    openNotional: longValue,
    // Per-symbol exposure is not derivable from a balance payload alone; the
    // caller overlays it from the book. null ⇒ max-position fails closed.
    positionNotionalForSymbol: null,
    ordersToday: extras.ordersToday ?? 0,
    peakEquity: extras.peakEquity ?? equity,
    asOf: extras.asOf ?? null,
  };
}
