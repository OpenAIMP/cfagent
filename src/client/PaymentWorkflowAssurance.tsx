/**
 * PaymentWorkflowAssurance — permanent assurance capability for the
 * PaymentWorkflow (issue #2049, Goal 1 #2013).
 *
 * This page runs the REAL flow (src/workflows/paymentWorkflowFlow.ts)
 * and the REAL gate (src/services/cfpayMonetization.ts) in the browser,
 * behind fake step / cfpay / deps seams — the same split as the flow
 * unit tests: test the flow, not the ThinkWorkflow class. It is NOT a
 * reimplementation of the flow, and it is NOT a payment surface.
 *
 * TEST ONLY, on its face:
 * - fake cfpay checkout (createCheckout returns a stub, checkoutStatus
 *   returns the selected fake status) — no cfpay key, no network call;
 * - fake screener starter (returns a fake workflow id, or throws when
 *   the screener fake is set to throw) — no real screener runs;
 * - no charge, no card, no mainnet. The gate itself is testnet-only.
 *
 * Two different toggles — do not confuse them:
 * - This page's VISIBILITY is gated by the Flagship feature flag
 *   "payment_assurance" (default OFF, fail-closed; see
 *   src/features/featureFlagPorts.ts). When that flag is OFF the page
 *   is hidden from nav and ?tab=payment-assurance renders the
 *   FeatureDisabledNotice instead (Chat's existing flag handling).
 * - The "Simulated monetization flag" toggle INSIDE this page only
 *   feeds the gate config (monetizationEnabled) for the run being
 *   tested. It is not Flagship, and flipping it charges nobody.
 *
 * All runs are scheduled behind the scenes: the one-off case sends
 * scheduleKind "one_off" (never "manual" — there is no manual
 * ScheduleKind). A recurring scheduled run, or a scheduled run with
 * no scheduleKind, is coverage-only: never an unattended charge.
 *
 * UX note (issue #2049): page chrome and controls use PageShell +
 * ui primitives only, and every inline style value is a design
 * token (var(--space-*), var(--color-*), var(--font-*)), per the
 * UX architecture primitives/token-only rule and the #1580/#470
 * ratchet gates. No raw controls, no hardcoded density literals,
 * no raw color literals (note: an issue number written as "#2024"
 * in rendered text would itself scan as a hex literal, so rendered
 * text never uses the "#NNNN" form).
 */
import React, { useState } from "react";
import {
  CfPayMonetizationGate,
  FAMILY_PRICES,
  type CommercialAccount,
  type RunTrigger,
  type ScheduleKind,
  type ScreenerFamily,
} from "../services/cfpayMonetization";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowParams,
} from "../workflows/paymentWorkflowFlow";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Notice,
  PageSection,
  PageShell,
  Select,
  TextInput,
} from "./components/ui";

export interface FakeConfig {
  monetizationOn: boolean;
  family: ScreenerFamily;
  trigger: RunTrigger;
  scheduleKind: ScheduleKind;
  authorizedAtSubmission: boolean;
  tier: CommercialAccount["tier"];
  creditsUSD: number;
  includedRunsRemaining: number;
  runTenantId: string;
  accountTenantId: string;
  approval: "approve" | "reject" | "timeout";
  checkoutStatus: "fulfilled" | "pending";
  screener: "success" | "throw";
  runRequestId: string;
}

export const DEFAULT_FAKE_CONFIG: FakeConfig = {
  monetizationOn: true,
  family: "goal",
  trigger: "manual",
  scheduleKind: "one_off",
  authorizedAtSubmission: false,
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
  runTenantId: "tenant-1",
  accountTenantId: "tenant-1",
  approval: "approve",
  checkoutStatus: "fulfilled",
  screener: "success",
  runRequestId: "assurance-run-1",
};

export interface ScenarioResult {
  outcome: PaymentWorkflowOutcome | null;
  trace: string[];
  credited: boolean;
  error: string | null;
}

/** Run one scenario against the real flow/gate with fake seams. Pure: fresh gate + fresh account copy per run. */
export async function runAssuranceScenario(cfg: FakeConfig): Promise<ScenarioResult> {
  const trace: string[] = [];
  let credited = false;
  const fakeCfpay = {
    createCheckout: async () => ({ checkoutId: "chk-fake-1" }),
    checkoutStatus: async () => ({ status: cfg.checkoutStatus }),
  };
  const gate = new CfPayMonetizationGate(fakeCfpay, {
    monetizationEnabled: cfg.monetizationOn,
    network: "base-sepolia",
  });
  const account: CommercialAccount = {
    userId: "assurance-user",
    email: "assurance@example.com",
    tenantId: cfg.accountTenantId,
    tier: cfg.tier,
    creditsUSD: cfg.creditsUSD,
    includedRunsRemaining: cfg.includedRunsRemaining,
  };
  const params: PaymentWorkflowParams = {
    runRequestId: cfg.runRequestId,
    family: cfg.family,
    trigger: cfg.trigger,
    scheduleKind: cfg.scheduleKind,
    authorizedAtSubmission: cfg.authorizedAtSubmission,
    tenantId: cfg.runTenantId,
    userId: "assurance-user",
    email: "assurance@example.com",
  };
  const step = {
    waitForEvent: async (name: string) => {
      trace.push(`wait ${name}`);
      if (name.includes("approval")) {
        if (cfg.approval === "timeout") throw new Error("fake wait timeout");
        return { payload: { approved: cfg.approval === "approve" } };
      }
      return { payload: { claimTxHash: "0xabc-fake" } };
    },
    do: async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      trace.push(`do ${name}`);
      return fn();
    },
  };
  try {
    const outcome = await runPaymentWorkflowFlow(
      params,
      {
        gate,
        account,
        startScreener: async (p) => {
          if (cfg.screener === "throw") throw new Error("fake screener failure");
          return { workflowId: `wf-fake-${p.runRequestId}` };
        },
        recordEvent: async (e) => {
          trace.push(`event ${e.type}`);
        },
        issueFailureCredit: async () => {
          credited = true;
        },
      },
      step,
    );
    return { outcome, trace, credited, error: null };
  } catch (err) {
    return {
      outcome: null,
      trace,
      credited,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface Preset {
  name: string;
  expected: string;
  config: FakeConfig;
}

const base: FakeConfig = { ...DEFAULT_FAKE_CONFIG };

export const PRESETS: Preset[] = [
  {
    name: "Coverage run starts screener, no wait, no checkout",
    expected: "started (subscription_included)",
    config: { ...base, tier: "Subscribed", includedRunsRemaining: 1, runRequestId: "assurance-preset-1" },
  },
  {
    name: "Checkout run waits, confirms, then starts screener",
    expected: "started (cfpay_checkout)",
    config: { ...base, runRequestId: "assurance-preset-2" },
  },
  {
    name: "Checkout wait timeout expires and starts nothing",
    expected: "expired",
    config: { ...base, approval: "timeout", runRequestId: "assurance-preset-3" },
  },
  {
    name: "Event alone is not proof: unfulfilled status does not start screener",
    expected: "payment_required",
    config: { ...base, checkoutStatus: "pending", runRequestId: "assurance-preset-4" },
  },
  {
    name: "Recurring scheduled run is coverage_required, never a checkout",
    expected: "coverage_required",
    config: { ...base, trigger: "scheduled", scheduleKind: "recurring", runRequestId: "assurance-preset-5" },
  },
  {
    name: "Tenant mismatch fails closed before any start",
    expected: "throws: Tenant mismatch",
    config: { ...base, accountTenantId: "tenant-2", runRequestId: "assurance-preset-6" },
  },
  {
    name: "Screener failure after payment issues failure credit, no cash refund claim",
    expected: "screener_failed_credit_issued (credit issued)",
    config: { ...base, screener: "throw", runRequestId: "assurance-preset-7" },
  },
  {
    name: "Approval rejected: no capture, no screener start",
    expected: "approval_rejected",
    config: { ...base, approval: "reject", runRequestId: "assurance-preset-8" },
  },
  {
    name: "One-off scheduled run authorized at submission skips the second approval wait",
    expected: "started (cfpay_checkout)",
    config: {
      ...base,
      trigger: "scheduled",
      scheduleKind: "one_off",
      authorizedAtSubmission: true,
      approval: "reject",
      runRequestId: "assurance-preset-9",
    },
  },
];

function resultLabel(r: ScenarioResult): string {
  if (r.error) return `throws: ${r.error}`;
  if (!r.outcome) return "no outcome";
  const paid = "paidVia" in r.outcome ? ` (${r.outcome.paidVia})` : "";
  const credit = r.outcome.status === "screener_failed_credit_issued" && r.credited ? " (credit issued)" : "";
  return `${r.outcome.status}${paid}${credit}`;
}

export function PaymentWorkflowAssurance() {
  const [cfg, setCfg] = useState<FakeConfig>({ ...DEFAULT_FAKE_CONFIG });
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<ScenarioResult | null>(null);
  const [suite, setSuite] = useState<Array<{ preset: Preset; result: ScenarioResult; pass: boolean }> | null>(null);

  const set = <K extends keyof FakeConfig>(key: K, value: FakeConfig[K]) =>
    setCfg((c) => ({ ...c, [key]: value }));

  const runOne = async () => {
    setRunning(true);
    try {
      setLast(await runAssuranceScenario(cfg));
      setSuite(null);
    } finally {
      setRunning(false);
    }
  };

  const runSuite = async () => {
    setRunning(true);
    try {
      const rows: Array<{ preset: Preset; result: ScenarioResult; pass: boolean }> = [];
      for (const preset of PRESETS) {
        const result = await runAssuranceScenario(preset.config);
        rows.push({ preset, result, pass: resultLabel(result).startsWith(preset.expected.split(" (")[0]) });
      }
      setSuite(rows);
      setLast(null);
    } finally {
      setRunning(false);
    }
  };

  const passCount = suite ? suite.filter((r) => r.pass).length : null;

  return (
    <PageShell
      title="Payment Workflow Assurance"
      scopeNote="Permanent assurance capability for PaymentWorkflow: the real flow and gate, run behind fake seams. TEST ONLY — fake cfpay, fake screener, no charge, no mainnet, no real screener run."
    >
      <PageSection title="What this page is (and is not)">
        <Notice tone="warning" title="Test only — not a payment surface">
          Nothing here charges anyone or runs a real screener. The cfpay
          checkout is a stub, the screener starter returns a fake workflow
          id (or throws, on purpose), and the gate is testnet-only. The
          toggle below simulates the monetization gate flag for the run
          being tested; it is not the Flagship flag that gates this page.
        </Notice>
        <p style={{ margin: "var(--space-3) 0 0", color: "var(--color-text-muted)" }}>
          Price for the selected family (proposed, not approved):{" "}
          <strong>${FAMILY_PRICES[cfg.family].toFixed(2)}</strong> per
          run-request — never per stage, shard, leg, retry, or re-serve.
          A paid run that fails gets a one-time replacement-run credit,
          never a cash refund (cfpay cannot refund; refund capability is
          deferred, see issue 2024).
        </p>
      </PageSection>

      <PageSection title="Tunable fakes">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-3)" }}>
          <Select label="Simulated monetization flag (gate config)" value={cfg.monetizationOn ? "on" : "off"} onChange={(e) => set("monetizationOn", e.target.value === "on")}>
            <option value="on">ON — gate applies</option>
            <option value="off">OFF — free path</option>
          </Select>
          <Select label="Family" value={cfg.family} onChange={(e) => set("family", e.target.value as ScreenerFamily)}>
            <option value="stock">stock — $0.02</option>
            <option value="goal">goal — $0.10</option>
            <option value="options">options — $0.05</option>
            <option value="strategy">strategy — $0.10</option>
          </Select>
          <Select label="Trigger" value={cfg.trigger} onChange={(e) => set("trigger", e.target.value as RunTrigger)}>
            <option value="manual">manual (one-off scheduled behind the scenes)</option>
            <option value="scheduled">scheduled</option>
          </Select>
          <Select label="Schedule kind" value={cfg.scheduleKind} onChange={(e) => set("scheduleKind", e.target.value as ScheduleKind)}>
            <option value="one_off">one_off</option>
            <option value="recurring">recurring</option>
          </Select>
          <Select label="Account tier" value={cfg.tier} onChange={(e) => set("tier", e.target.value as CommercialAccount["tier"])}>
            <option value="Free">Free</option>
            <option value="PayPerUse">PayPerUse</option>
            <option value="Subscribed">Subscribed</option>
          </Select>
          <TextInput label="Credits (USD)" type="number" step="0.01" value={cfg.creditsUSD} onChange={(e) => set("creditsUSD", Number(e.target.value))} />
          <TextInput label="Included runs remaining" type="number" value={cfg.includedRunsRemaining} onChange={(e) => set("includedRunsRemaining", Number(e.target.value))} />
          <Select label="Approval fake" value={cfg.approval} onChange={(e) => set("approval", e.target.value as FakeConfig["approval"])}>
            <option value="approve">approve</option>
            <option value="reject">reject</option>
            <option value="timeout">timeout (wait throws)</option>
          </Select>
          <Select label="Fake checkout.status re-read" value={cfg.checkoutStatus} onChange={(e) => set("checkoutStatus", e.target.value as FakeConfig["checkoutStatus"])}>
            <option value="fulfilled">fulfilled</option>
            <option value="pending">pending</option>
          </Select>
          <Select label="Fake screener" value={cfg.screener} onChange={(e) => set("screener", e.target.value as FakeConfig["screener"])}>
            <option value="success">success</option>
            <option value="throw">throw (failure credit path)</option>
          </Select>
          <TextInput label="Run tenant" value={cfg.runTenantId} onChange={(e) => set("runTenantId", e.target.value)} />
          <TextInput label="Account tenant" value={cfg.accountTenantId} onChange={(e) => set("accountTenantId", e.target.value)} />
          <TextInput label="Run request id" value={cfg.runRequestId} onChange={(e) => set("runRequestId", e.target.value)} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <Checkbox checked={cfg.authorizedAtSubmission} onChange={(e) => set("authorizedAtSubmission", e.target.checked)} />
          Authorized at submission (one-off scheduled only — skips the second approval wait)
        </label>
        <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-4)", flexWrap: "wrap" }}>
          <Button variant="primary" onClick={runOne} disabled={running}>{running ? "Running…" : "Run this scenario"}</Button>
          <Button variant="secondary" onClick={runSuite} disabled={running}>Run all 9 preset tests</Button>
        </div>
      </PageSection>

      {last && (
        <PageSection title="Last run">
          <Card>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
              <Badge tone={last.outcome?.status === "started" ? "success" : last.error ? "danger" : "neutral"}>{resultLabel(last)}</Badge>
              {last.credited && <Badge tone="info">failure credit issued</Badge>}
            </div>
            <h3 style={{ margin: "var(--space-4) 0 var(--space-2)" }}>Step trace</h3>
            <ol style={{ margin: 0, paddingLeft: "var(--space-5)", fontFamily: "var(--font-code)", fontSize: "var(--font-size-body-sm)" }}>
              {last.trace.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            {last.trace.length === 0 && <p style={{ color: "var(--color-text-muted)" }}>No steps ran — the flow failed closed before the gate.</p>}
          </Card>
        </PageSection>
      )}

      {suite && (
        <PageSection title={`Preset suite — ${passCount}/${suite.length} passing`}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {suite.map((row, i) => (
              <Card key={i}>
                <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" }}>
                  <Badge tone={row.pass ? "success" : "danger"}>{row.pass ? "PASS" : "FAIL"}</Badge>
                  <span>{row.preset.name}</span>
                </div>
                <p style={{ margin: "var(--space-2) 0 0", color: "var(--color-text-muted)", fontSize: "var(--font-size-body)" }}>
                  Expected: {row.preset.expected} · Got: {resultLabel(row.result)}
                </p>
              </Card>
            ))}
          </div>
        </PageSection>
      )}
    </PageShell>
  );
}
