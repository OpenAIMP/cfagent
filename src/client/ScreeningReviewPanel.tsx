/**
 * ScreeningReviewPanel — consolidation C2 (issue #1246, epic #1151).
 *
 * The hub's proposal review inbox: everything the autonomous
 * screening system proposes, in one place, with the decision actions
 * wired to the endpoints that already govern them —
 *
 *  - Adaptation candidates (the #757→#760 improvement pipeline):
 *    evaluate (counterfactual replay), run the promotion gate
 *    (held-out significance), request a human approval, decide it,
 *    then start / advance the staged promotion. No action here
 *    bypasses that flow: the buttons call the same endpoints, with
 *    the same governance (no self-promotion; approvals are recorded;
 *    promotion applies only through the staged seam).
 *  - Goal proposals (Phase 0 store): goals the discovery pass
 *    persisted as proposed-only. Activate / dismiss go through
 *    POST /api/screening/goals/decide, which moves only proposed
 *    goals, tenant-scoped, and logs the decision.
 *  - Strategy-bank re-selection proposals (Phase 3): the nightly
 *    transparency log — read-only here on purpose. Their governance
 *    is proposal_only_not_promoted: promotion runs through the
 *    champion/challenger gate above, never from this list.
 *  - Strategy weights (read path): the current weights and the
 *    policy evaluation behind them (#754), shown for context.
 *
 * Fail-soft per section (the ScreeningActivityPanel idiom): a
 * section whose API is unavailable says so; nothing is fabricated.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";

interface CandidateView {
  id: string;
  target: string;
  change: { action: string; parameter?: string; from?: unknown; to?: unknown; description: string };
  hypothesis: string;
  expectedEffect: { metric: string; direction: string };
  provenance: { source: string; id: string };
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface EvaluationView {
  id?: string;
  method: string;
  baselineMetric: number | null;
  candidateMetric: number | null;
  delta: number | null;
  sampleSize: number;
  createdAt?: string;
}

interface ApprovalView {
  id: string;
  candidateId: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface VerdictView {
  id: string;
  candidateId: string;
  passed: boolean;
  reasons: string[];
  z: number | null;
  pValue: number | null;
  createdAt: string;
}

interface PromotionView {
  id: string;
  candidateId: string;
  stage: string;
  stageStartedAt: string;
  createdAt: string;
}

interface GoalView {
  id: string;
  kind: string;
  title: string;
  status: string;
  source: string;
  createdAt: string;
  scenarios: Array<{ id: string; status: string }>;
}

interface ReselectionView {
  id: string;
  regime: string;
  createdAt: string;
  proposal: {
    governance: string;
    overallWinRate: number | null;
    activeSet: Array<{ strategy: string }>;
    evaluatedCount: number;
    costUnitsUsed: number;
    costCapUnits: number;
  };
}

interface WeightsView {
  weights: Record<string, number>;
  evaluation: {
    unweightedWinRate: number | null;
    weightedWinRate: number | null;
    proposals: unknown[];
    lowSample: string[];
  } | null;
}

interface CandidateDetail {
  evaluations: EvaluationView[];
  approvals: ApprovalView[];
  verdicts: VerdictView[];
  promotions: PromotionView[];
}

const boxStyle: React.CSSProperties = {
  margin: "0 0 1rem",
  padding: "1rem 1.25rem",
  background: "var(--color-surface-sunken)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "8px",
};

const muted: React.CSSProperties = { color: "var(--color-text-muted)", fontSize: "0.85rem" };
const bodyText: React.CSSProperties = { color: "var(--color-text-secondary)", fontSize: "0.9rem", lineHeight: 1.5 };

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function metric(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(3);
}

export function ScreeningReviewPanel({ userLogin }: { userLogin?: string }) {
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [weights, setWeights] = useState<WeightsView | null>(null);
  const [weightsError, setWeightsError] = useState(false);
  const [goals, setGoals] = useState<GoalView[] | null>(null);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [reselection, setReselection] = useState<ReselectionView[] | null>(null);
  const [reselectionError, setReselectionError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    return {
      "Content-Type": "application/json",
      ...(userLogin ? { "x-user-login": userLogin } : {}),
    };
  }, [userLogin]);

  const loadCandidates = useCallback(async () => {
    try {
      const res = await apiFetch("/api/adaptation/candidates", { headers: headers() });
      if (!res.ok) throw new Error("candidates unavailable");
      const body = (await res.json()) as { candidates?: CandidateView[] };
      setCandidates(Array.isArray(body.candidates) ? body.candidates : []);
      setCandidatesError(null);
    } catch {
      setCandidatesError("Adaptation candidates are unavailable right now.");
    }
  }, [headers]);

  const loadWeights = useCallback(async () => {
    try {
      const res = await apiFetch("/api/adaptation/weights", { headers: headers() });
      if (!res.ok) throw new Error("weights unavailable");
      const body = (await res.json()) as WeightsView;
      setWeights(body);
      setWeightsError(false);
    } catch {
      setWeightsError(true);
    }
  }, [headers]);

  const loadGoals = useCallback(async () => {
    try {
      const res = await apiFetch("/api/screening/goals?status=proposed", { headers: headers() });
      if (!res.ok) throw new Error("goals unavailable");
      const body = (await res.json()) as { goals?: GoalView[] };
      setGoals(Array.isArray(body.goals) ? body.goals : []);
      setGoalsError(null);
    } catch {
      setGoalsError("Goal proposals are unavailable right now.");
    }
  }, [headers]);

  const loadReselection = useCallback(async () => {
    try {
      const res = await apiFetch("/api/screening/reselection-proposals", { headers: headers() });
      if (!res.ok) throw new Error("reselection unavailable");
      const body = (await res.json()) as { proposals?: ReselectionView[] };
      setReselection(Array.isArray(body.proposals) ? body.proposals : []);
      setReselectionError(null);
    } catch {
      setReselectionError("Re-selection proposals are unavailable right now.");
    }
  }, [headers]);

  const loadDetail = useCallback(
    async (candidateId: string) => {
      const [evaluations, approvals, verdicts, promotions] = await Promise.all([
        apiFetch(`/api/adaptation/candidates/evaluations?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { evaluations?: EvaluationView[] }).evaluations ?? [])
          .catch(() => [] as EvaluationView[]),
        apiFetch(`/api/adaptation/candidates/approvals?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { approvals?: ApprovalView[] }).approvals ?? [])
          .catch(() => [] as ApprovalView[]),
        apiFetch(`/api/adaptation/candidates/verdicts?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { verdicts?: VerdictView[] }).verdicts ?? [])
          .catch(() => [] as VerdictView[]),
        apiFetch(`/api/adaptation/promotions?candidateId=${encodeURIComponent(candidateId)}`, { headers: headers() })
          .then(async (r) => ((await r.json()) as { promotions?: PromotionView[] }).promotions ?? [])
          .catch(() => [] as PromotionView[]),
      ]);
      setDetail({ evaluations, approvals, verdicts, promotions });
    },
    [headers],
  );

  useEffect(() => {
    void loadCandidates();
    void loadWeights();
    void loadGoals();
    void loadReselection();
  }, [loadCandidates, loadWeights, loadGoals, loadReselection]);

  const post = useCallback(
    async (path: string, body: unknown): Promise<any> => {
      const res = await apiFetch(path, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`);
      }
      return data;
    },
    [headers],
  );

  const runAction = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      setActionMessage(null);
      try {
        setActionMessage(await fn());
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `${label} failed.`);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const openCandidate = async (candidateId: string) => {
    if (selectedId === candidateId) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(candidateId);
    setDetail(null);
    setActionMessage(null);
    setActionError(null);
    await loadDetail(candidateId);
  };

  const pendingApproval = detail?.approvals.find((a) => a.status === "pending");
  const latestVerdict = detail?.verdicts[0];
  const latestEvaluation = detail?.evaluations[0];

  return (
    <section aria-label="Screening proposal review" style={{ margin: "1rem 0" }}>
      <h3 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "1.15rem" }}>
        🗳️ Proposal Review
      </h3>
      <p style={{ margin: "0 0 1rem", ...bodyText }}>
        Everything the screening system proposes — adaptation candidates, discovered goals, and
        strategy-bank re-selections — decided here, through the same governed endpoints that
        produced them. Nothing activates, promotes, or trades without a recorded human decision.
      </p>
      {actionMessage && (
        <p role="status" style={{ margin: "0 0 0.75rem", color: "var(--color-success)", fontSize: "0.88rem" }}>
          {actionMessage}
        </p>
      )}
      {actionError && (
        <p role="alert" style={{ margin: "0 0 0.75rem", color: "var(--color-danger)", fontSize: "0.88rem" }}>
          {actionError}
        </p>
      )}

      {/* ---------------- Adaptation candidates ---------------- */}
      <div style={boxStyle}>
        <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-primary)", fontSize: "1rem" }}>
          Adaptation candidates
        </h4>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Improvement candidates from the track record, reflections, and learnings. The governed
          path: evaluate → promotion gate (held-out significance) → human approval → staged
          promotion. The gate verdict sits beside the decision — a promotion cannot be confirmed
          without it.
        </p>
        {candidatesError && <p style={muted}>{candidatesError}</p>}
        {candidates !== null && candidates.length === 0 && !candidatesError && (
          <p style={muted}>No adaptation candidates are waiting for review.</p>
        )}
        {candidates?.map((candidate) => (
          <div
            key={candidate.id}
            style={{
              padding: "0.75rem 0",
              borderTop: "1px solid var(--color-border-subtle)",
            }}
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
              <strong style={{ color: "var(--color-text-primary)", fontSize: "0.92rem" }}>
                {candidate.change.description}
              </strong>
              <span style={muted}>
                {candidate.target} · status: {candidate.status}
              </span>
            </div>
            <p style={{ margin: "0.35rem 0 0.5rem", ...bodyText }}>{candidate.hypothesis}</p>
            <p style={{ margin: "0 0 0.5rem", ...muted }}>
              Expected effect: {candidate.expectedEffect.metric} to {candidate.expectedEffect.direction} ·
              proposed from {candidate.provenance.source} · {new Date(candidate.createdAt).toLocaleString()}
            </p>
            <button type="button" onClick={() => void openCandidate(candidate.id)} disabled={busy}>
              {selectedId === candidate.id ? "Close review" : "Review candidate"}
            </button>

            {selectedId === candidate.id && detail && (
              <div style={{ marginTop: "0.75rem" }}>
                <p style={{ margin: "0 0 0.35rem", ...bodyText }}>
                  <strong>Latest evaluation:</strong>{" "}
                  {latestEvaluation
                    ? `${latestEvaluation.method} — baseline ${metric(latestEvaluation.baselineMetric)} → candidate ${metric(latestEvaluation.candidateMetric)} (Δ ${metric(latestEvaluation.delta)}, n=${latestEvaluation.sampleSize})`
                    : "none recorded yet."}
                </p>
                <p style={{ margin: "0 0 0.5rem", ...bodyText }}>
                  <strong>Promotion gate verdict:</strong>{" "}
                  {latestVerdict
                    ? `${latestVerdict.passed ? "PASSED" : "FAILED"} — ${latestVerdict.reasons.join("; ") || "no reasons recorded"}` +
                      (latestVerdict.pValue !== null ? ` (p=${latestVerdict.pValue})` : "")
                    : "not run yet."}
                </p>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Evaluation", async () => {
                        const data = await post("/api/adaptation/candidates/evaluate", { candidateId: candidate.id });
                        await loadDetail(candidate.id);
                        const ev = data.evaluation as EvaluationView;
                        return `Evaluation recorded: candidate ${metric(ev.candidateMetric)} vs baseline ${metric(ev.baselineMetric)} (n=${ev.sampleSize}).`;
                      })
                    }
                  >
                    Evaluate candidate
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction("Gate", async () => {
                        const data = await post("/api/adaptation/candidates/gate", { candidateId: candidate.id });
                        await loadDetail(candidate.id);
                        await loadCandidates();
                        return `Gate verdict: ${data.verdict?.passed ? "PASSED" : "FAILED"} — ${(data.verdict?.reasons ?? []).join("; ")}`;
                      })
                    }
                  >
                    Run promotion gate
                  </button>
                  {!pendingApproval && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction("Approval request", async () => {
                          await post("/api/adaptation/candidates/approve", { candidateId: candidate.id });
                          await loadDetail(candidate.id);
                          return "Approval requested. It stays pending until a person decides it below.";
                        })
                      }
                    >
                      Request approval
                    </button>
                  )}
                  {candidate.status === "gated" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction("Start promotion", async () => {
                          const data = await post("/api/adaptation/promotions/start", { candidateId: candidate.id });
                          await loadDetail(candidate.id);
                          await loadCandidates();
                          if (data.success === false) {
                            throw new Error(typeof data.reason === "string" ? data.reason : "Promotion could not start.");
                          }
                          return "Staged promotion started in shadow — nothing is applied yet.";
                        })
                      }
                    >
                      Start staged promotion
                    </button>
                  )}
                </div>

                {pendingApproval && (
                  <div
                    style={{
                      padding: "0.75rem",
                      border: "1px solid var(--color-border-focus)",
                      borderRadius: "6px",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <p style={{ margin: "0 0 0.5rem", ...bodyText }}>
                      <strong>Pending approval</strong> requested by {pendingApproval.requestedBy ?? "unknown"} ·{" "}
                      {new Date(pendingApproval.createdAt).toLocaleString()}. Gate verdict at decision time:{" "}
                      {latestVerdict ? `${latestVerdict.passed ? "PASSED" : "FAILED"} (p=${latestVerdict.pValue ?? "—"})` : "not run"}.
                    </p>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction("Decision", async () => {
                            await post("/api/adaptation/candidates/approve/decide", {
                              approvalId: pendingApproval.id,
                              decision: "approved",
                            });
                            await loadDetail(candidate.id);
                            return "Approval recorded as approved.";
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction("Decision", async () => {
                            await post("/api/adaptation/candidates/approve/decide", {
                              approvalId: pendingApproval.id,
                              decision: "rejected",
                            });
                            await loadDetail(candidate.id);
                            return "Approval recorded as rejected.";
                          })
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {detail.approvals.filter((a) => a.status !== "pending").length > 0 && (
                  <ul style={{ margin: "0 0 0.5rem", paddingLeft: "1.1rem" }}>
                    {detail.approvals
                      .filter((a) => a.status !== "pending")
                      .map((a) => (
                        <li key={a.id} style={muted}>
                          Approval {a.status} by {a.decidedBy ?? "unknown"}
                          {a.decidedAt ? ` · ${new Date(a.decidedAt).toLocaleString()}` : ""}
                        </li>
                      ))}
                  </ul>
                )}

                {detail.promotions.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {detail.promotions.map((promotion) => (
                      <li key={promotion.id} style={{ ...bodyText, marginBottom: "0.35rem" }}>
                        Promotion stage: <strong>{promotion.stage}</strong> since{" "}
                        {new Date(promotion.stageStartedAt).toLocaleString()}{" "}
                        {promotion.stage !== "completed" && promotion.stage !== "rolled_back" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void runAction("Advance promotion", async () => {
                                const data = await post("/api/adaptation/promotions/advance", {
                                  promotionId: promotion.id,
                                });
                                await loadDetail(candidate.id);
                                await loadCandidates();
                                if (data.success === false) {
                                  throw new Error(typeof data.reason === "string" ? data.reason : "Promotion could not advance.");
                                }
                                return `Promotion ${data.action ?? "advanced"} (stage: ${data.promotion?.stage ?? "updated"}).`;
                              })
                            }
                          >
                            Advance promotion
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---------------- Goal proposals ---------------- */}
      <div style={boxStyle}>
        <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-primary)", fontSize: "1rem" }}>
          Goal proposals
        </h4>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Goals the discovery pass persisted as proposals. Activating one makes it a live goal for
          goal-driven screens; dismissing archives it. Only proposed goals can be decided, and the
          decision is written to the screening activity log.
        </p>
        {goalsError && <p style={muted}>{goalsError}</p>}
        {goals !== null && goals.length === 0 && !goalsError && (
          <p style={muted}>No proposed goals are waiting.</p>
        )}
        {goals?.map((goal) => (
          <div key={goal.id} style={{ padding: "0.75rem 0", borderTop: "1px solid var(--color-border-subtle)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
              <strong style={{ color: "var(--color-text-primary)", fontSize: "0.92rem" }}>{goal.title}</strong>
              <span style={muted}>
                {goal.kind} · from {goal.source} · {goal.scenarios.length} scenario
                {goal.scenarios.length === 1 ? "" : "s"} · {new Date(goal.createdAt).toLocaleString()}
              </span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Goal decision", async () => {
                    await post("/api/screening/goals/decide", { id: goal.id, decision: "activate" });
                    await loadGoals();
                    return `Goal '${goal.title}' activated.`;
                  })
                }
              >
                Activate goal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Goal decision", async () => {
                    await post("/api/screening/goals/decide", { id: goal.id, decision: "dismiss" });
                    await loadGoals();
                    return `Goal '${goal.title}' dismissed (archived).`;
                  })
                }
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ---------------- Re-selection proposals ---------------- */}
      <div style={boxStyle}>
        <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-primary)", fontSize: "1rem" }}>
          Strategy-bank re-selection proposals
        </h4>
        <p style={{ margin: "0 0 0.75rem", ...muted }}>
          Governance: proposal only — not promoted. The nightly re-selection records what it would
          run; promotion happens only through the champion/challenger gate above. There is
          deliberately no action on this list.
        </p>
        {reselectionError && <p style={muted}>{reselectionError}</p>}
        {reselection !== null && reselection.length === 0 && !reselectionError && (
          <p style={muted}>No re-selection proposals recorded yet.</p>
        )}
        {reselection?.map((row) => (
          <div key={row.id} style={{ padding: "0.75rem 0", borderTop: "1px solid var(--color-border-subtle)" }}>
            <p style={{ margin: 0, ...bodyText }}>
              <strong>{row.regime}</strong> regime · overall win rate {pct(row.proposal.overallWinRate)} ·{" "}
              {row.proposal.evaluatedCount} evaluated · cost {row.proposal.costUnitsUsed}/
              {row.proposal.costCapUnits} units · {new Date(row.createdAt).toLocaleString()}
            </p>
            <p style={{ margin: "0.35rem 0 0", ...muted }}>
              Proposed active set:{" "}
              {row.proposal.activeSet.map((a) => a.strategy).join(", ") || "none"}
            </p>
          </div>
        ))}
      </div>

      {/* ---------------- Strategy weights ---------------- */}
      <div style={boxStyle}>
        <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-text-primary)", fontSize: "1rem" }}>
          Strategy weights
        </h4>
        {weightsError && (
          <p style={muted}>Strategy weights are unavailable right now (the research agent read path did not answer).</p>
        )}
        {weights && (
          <>
            <p style={{ margin: "0 0 0.5rem", ...bodyText }}>
              Weighted win rate {pct(weights.evaluation?.weightedWinRate)} vs unweighted{" "}
              {pct(weights.evaluation?.unweightedWinRate)}.
              {weights.evaluation && weights.evaluation.lowSample.length > 0
                ? ` Low-sample (read with care): ${weights.evaluation.lowSample.join(", ")}.`
                : ""}
            </p>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {Object.entries(weights.weights).map(([strategy, weight]) => (
                <li key={strategy} style={muted}>
                  {strategy}: {weight}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
