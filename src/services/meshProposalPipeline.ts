/**
 * Issue #2460 (Agent Mesh S19, programme #2225 G13c) — the RSI
 * proposal pipeline: the improvement loop's Propose stage
 * (doors-and-layers §7.4). It turns evidence into proposals and
 * files the proposals that clear its evidence bar as §5 GitHub
 * issues. Filing is its maximum reach: the pipeline never
 * branches, never merges, never mutates production — the filed
 * issue enters the same gitops gate as any lane's work.
 *
 * Evidence discipline is #1742's, applied per signal kind:
 *  - A signal is only ever a claim with samples behind it. The
 *    bar is a sample floor AND a strict-majority failure rate:
 *    a tie is noise, not a signal (the calibration engine's
 *    rule, reused verbatim for calibration signals via
 *    CALIBRATION_MIN_SAMPLE itself).
 *  - Golden tasks are deterministic — a failure is reproducible
 *    by construction — so their floor is smaller than the
 *    calibration floor: MESH_PROPOSAL_MIN_RUNS recorded runs,
 *    guarding against single-run driver error rather than
 *    sampling noise. A golden-task signal additionally requires
 *    the LATEST result to have failed: a task that has recovered
 *    on its own has no live failure to propose against.
 *  - The bar is re-verified at advancement time from the
 *    caller-supplied fresh signal, never trusted from draft
 *    time. A proposal whose evidence does not clear the bar
 *    cannot advance, and the refusal is itself recorded
 *    (state evidence-refused, with the verdict's reasons).
 *  - One open proposal per signal (the #1742 dedup rule): an
 *    open duplicate is returned, never re-drafted or re-filed.
 *  - A proposal must carry a falsification criterion to exist:
 *    what would prove it wrong, stated at draft time.
 *
 * Inputs are read through ports, never scraped from reports:
 * golden-task outcomes come from the S18 eval result store
 * (MeshEvalResultStore); calibration verdicts are supplied by
 * the caller as rows and mapped by calibrationSignalFromVerdict
 * (the #1742 store is tenant-scoped and its reader belongs to a
 * production caller — a named follow-up, like the caller
 * itself). S17 trace evidence rides inside the eval results
 * (each failing result's trace id is carried into the refs).
 *
 * On filing, the proposal also bridges into the foundation
 * proposal ledger (#2288) when one is injected: the ledger's
 * proposed → approved → applied → verified machine is the
 * filed proposal's downstream lifecycle, with its gates
 * recorded as data there — this pipeline's store does not
 * duplicate that machine.
 */
import { CALIBRATION_MIN_SAMPLE } from "../telemetry/telemetryPorts";
import type {
  MeshEvalResultStore,
  MeshEvalTaskResult,
} from "../data/meshEvalPorts";
import type {
  MeshProposalBarVerdict,
  MeshProposalEvidenceRef,
  MeshProposalRecord,
  MeshProposalStore,
} from "../data/meshProposalPorts";
import type { ProposalLedgerStore } from "../data/proposalLedgerPorts";
import { MESH_GOLDEN_TASKS } from "./meshGoldenTasks";

/** Recorded runs a golden task needs before its failures are evidence. */
export const MESH_PROPOSAL_MIN_RUNS = 3;

/** Stable pipeline error codes — callers match on `code`. */
export const MESH_PROPOSAL_NO_FALSIFICATION = "MESH_PROPOSAL_NO_FALSIFICATION";
export const MESH_PROPOSAL_EVIDENCE_BAR = "MESH_PROPOSAL_EVIDENCE_BAR";
export const MESH_PROPOSAL_NOT_CHECKED = "MESH_PROPOSAL_NOT_CHECKED";
export const MESH_PROPOSAL_NO_FILER = "MESH_PROPOSAL_NO_FILER";
export const MESH_PROPOSAL_NOT_FOUND = "MESH_PROPOSAL_NOT_FOUND";
export const MESH_PROPOSAL_SIGNAL_MISMATCH = "MESH_PROPOSAL_SIGNAL_MISMATCH";

/** A coded pipeline refusal. */
export class MeshProposalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MeshProposalError";
    this.code = code;
  }
}

/** One evidence claim, aggregated from its source records. */
export interface MeshEvidenceSignal {
  /** Dedup key: one open proposal per signal. */
  signalKey: string;
  kind: "golden-task" | "calibration";
  /** The task id, or `<agentKey>/<thesis>` for a calibration slice. */
  subject: string;
  /** Recorded runs (golden-task) or evaluated ideas (calibration). */
  samples: number;
  /** Failed runs, or falsified ideas. */
  failures: number;
  /** failures / samples; null when there are no samples. */
  failureRate: number | null;
  /** Golden-task only: the most recent result failed. */
  latestFailed: boolean;
  evidenceRefs: MeshProposalEvidenceRef[];
}

/**
 * Evaluate a signal against the evidence bar. Pure and total:
 * every refusal names its reasons, so a recorded verdict never
 * needs a human to reconstruct why the bar said no.
 */
export function evaluateEvidenceBar(signal: MeshEvidenceSignal): MeshProposalBarVerdict {
  const reasons: string[] = [];
  const floor =
    signal.kind === "calibration" ? CALIBRATION_MIN_SAMPLE : MESH_PROPOSAL_MIN_RUNS;
  if (signal.samples < floor) {
    reasons.push(
      `samples ${signal.samples} below the floor ${floor} for ${signal.kind} signals — an anecdote is not evidence`,
    );
  }
  if (signal.failureRate === null || signal.failureRate <= 0.5) {
    reasons.push(
      `failure rate ${signal.failureRate === null ? "n/a" : signal.failureRate.toFixed(2)} is not a strict majority (> 0.5) — a tie is noise, not a signal`,
    );
  }
  if (signal.kind === "golden-task" && !signal.latestFailed) {
    reasons.push(
      "the latest recorded result passed — there is no live failure to propose against",
    );
  }
  return { passes: reasons.length === 0, reasons };
}

function evalSignalForTask(
  taskId: string,
  results: MeshEvalTaskResult[],
): MeshEvidenceSignal | null {
  if (results.length === 0) return null;
  const failed = results.filter((r) => !r.passed);
  const latest = results[results.length - 1];
  return {
    signalKey: `golden-task:${taskId}`,
    kind: "golden-task",
    subject: taskId,
    samples: results.length,
    failures: failed.length,
    failureRate: failed.length / results.length,
    latestFailed: !latest.passed,
    evidenceRefs: failed.map((r) => ({
      kind: "golden-task" as const,
      ref: r.runId,
      detail: {
        taskId: r.taskId,
        door: r.door,
        outcome: r.outcome,
        failures: r.failures.join("; "),
        traceId: r.traceId ?? "none",
        startedAtMs: r.startedAtMs,
      },
    })),
  };
}

/**
 * Read golden-task signals from the eval result store, through
 * the port. Defaults to the S18 catalog's task ids; a caller may
 * name a subset. Tasks with no recorded results produce no
 * signal — absence of runs is not a failure claim.
 */
export async function collectEvalSignals(
  store: MeshEvalResultStore,
  taskIds?: readonly string[],
): Promise<MeshEvidenceSignal[]> {
  const ids = taskIds ?? MESH_GOLDEN_TASKS.map((t) => t.id);
  const signals: MeshEvidenceSignal[] = [];
  for (const taskId of ids) {
    const signal = evalSignalForTask(taskId, await store.resultsForTask(taskId));
    if (signal) signals.push(signal);
  }
  return signals;
}

/** One calibration verdict row, as the #1742 engine aggregates it. */
export interface CalibrationVerdictRow {
  agentKey: string;
  thesis: string;
  evaluated: number;
  falsified: number;
}

/** Map a caller-supplied calibration verdict to a pipeline signal. */
export function calibrationSignalFromVerdict(row: CalibrationVerdictRow): MeshEvidenceSignal {
  return {
    signalKey: `calibration:${row.agentKey}/${row.thesis}`,
    kind: "calibration",
    subject: `${row.agentKey}/${row.thesis}`,
    samples: row.evaluated,
    failures: row.falsified,
    failureRate: row.evaluated > 0 ? row.falsified / row.evaluated : null,
    // The latest-failure condition is a golden-task rule; a
    // calibration slice is an aggregate, so the bar's floor +
    // strict-majority legs carry it.
    latestFailed: true,
    evidenceRefs: [
      {
        kind: "calibration",
        ref: `${row.agentKey}/${row.thesis}`,
        detail: {
          evaluated: row.evaluated,
          falsified: row.falsified,
          falsificationRate: row.evaluated > 0 ? row.falsified / row.evaluated : "n/a",
        },
      },
    ],
  };
}

/** The prose a drafter supplies; the pipeline supplies the evidence. */
export interface MeshProposalDraftFields {
  title: string;
  problem: string;
  proposedChange: string;
  expectedEffect: string;
  falsificationCriterion: string;
}

/** The filing seam: the pipeline's maximum reach, injectable for tests. */
export interface MeshProposalFiler {
  file(issue: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string }>;
}

/**
 * Build the §5 issue a filed proposal becomes. The body carries
 * the evidence refs and the bar verdict verbatim: the reviewer
 * of the filed issue sees exactly what the pipeline saw.
 */
export function buildProposalIssue(record: MeshProposalRecord): {
  title: string;
  body: string;
  labels: string[];
} {
  const evidenceLines = record.evidenceRefs.map((ref) => {
    const detail = Object.entries(ref.detail)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
    return `- [${ref.kind}] \`${ref.ref}\` — ${detail}`;
  });
  const body = [
    `## Agent`,
    `#CAIO-quns`,
    ``,
    `## Problem`,
    record.problem,
    ``,
    `## Outcome`,
    record.expectedEffect,
    ``,
    `## Scope`,
    `Included: ${record.proposedChange}`,
    `Excluded: anything beyond the proposed change — this issue is a proposal from evidence, scoped by its drafter.`,
    ``,
    `## Acceptance criteria`,
    `- [ ] The proposed change is implemented and the evidence below no longer reproduces`,
    `- [ ] The falsification criterion below has been evaluated against fresh records`,
    ``,
    `## Test plan`,
    `Re-run the evidence source named below (the golden-task harness for golden-task signals; the calibration read for calibration signals) and compare against the recorded refs.`,
    ``,
    `## Evidence`,
    `Signal: \`${record.signalKey}\``,
    ...(record.barVerdict
      ? [
          `Evidence bar: ${record.barVerdict.passes ? "PASSED" : "REFUSED"}${
            record.barVerdict.reasons.length > 0
              ? ` — ${record.barVerdict.reasons.join("; ")}`
              : ""
          }`,
        ]
      : []),
    ...evidenceLines,
    ``,
    `## Falsification criterion`,
    record.falsificationCriterion,
    ``,
    `## Dependencies`,
    `Filed by the RSI proposal pipeline (Agent Mesh S19, #2460) from programme #2225's improvement loop. Filing is the pipeline's maximum reach: implementation follows gitops (branch, PR, CI, review, merge) like any lane's work.`,
  ].join("\n");
  return {
    title: `[Enhancement] RSI proposal: ${record.title}`,
    body,
    labels: ["enhancement"],
  };
}

export interface MeshProposalPipelineDeps {
  proposals: MeshProposalStore;
  /** Absent in library-only use: filing then refuses, by design. */
  filer?: MeshProposalFiler;
  /** Optional bridge into the foundation proposal ledger (#2288). */
  ledger?: ProposalLedgerStore;
  now?: () => number;
}

/**
 * The pipeline. Deterministic throughout: no model call drafts,
 * checks, or files — drafting prose is supplied by the caller,
 * the bar is threshold arithmetic, the body is a template over
 * evidence scalars.
 */
export class MeshProposalPipeline {
  private readonly proposals: MeshProposalStore;
  private readonly filer?: MeshProposalFiler;
  private readonly ledger?: ProposalLedgerStore;
  private readonly now: () => number;

  constructor(deps: MeshProposalPipelineDeps) {
    this.proposals = deps.proposals;
    this.filer = deps.filer;
    this.ledger = deps.ledger;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Draft a proposal for a signal. Refuses a blank falsification
   * criterion; returns the existing open proposal for the signal
   * instead of drafting a duplicate (the #1742 dedup rule).
   */
  async draft(
    signal: MeshEvidenceSignal,
    fields: MeshProposalDraftFields,
  ): Promise<MeshProposalRecord> {
    if (!fields.falsificationCriterion || fields.falsificationCriterion.trim().length === 0) {
      throw new MeshProposalError(
        MESH_PROPOSAL_NO_FALSIFICATION,
        "a proposal without a falsification criterion cannot be drafted — what would prove it wrong must be stated first",
      );
    }
    const open = await this.proposals.openForSignal(signal.signalKey);
    if (open) return open;
    const at = this.now();
    const base = `mesh-proposal:${signal.signalKey}`;
    let id = base;
    let suffix = 1;
    // A refused predecessor keeps its id (its verdict is its
    // history); a re-draft after refusal takes a fresh one.
    while (await this.proposals.get(id)) {
      suffix += 1;
      id = `${base}~${suffix}`;
    }
    const record: MeshProposalRecord = {
      id,
      signalKey: signal.signalKey,
      title: fields.title,
      problem: fields.problem,
      proposedChange: fields.proposedChange,
      expectedEffect: fields.expectedEffect,
      falsificationCriterion: fields.falsificationCriterion,
      evidenceRefs: signal.evidenceRefs,
      state: "drafted",
      createdAtMs: at,
      updatedAtMs: at,
    };
    return this.proposals.save(record);
  }

  /**
   * Advance a drafted proposal against FRESH evidence: the bar
   * is evaluated from the supplied signal, not from draft-time
   * state. Pass → evidence-checked; refuse → evidence-refused
   * (terminal), with the verdict recorded either way.
   */
  async checkEvidence(
    id: string,
    signal: MeshEvidenceSignal,
  ): Promise<MeshProposalRecord> {
    const record = await this.mustGet(id);
    if (signal.signalKey !== record.signalKey) {
      throw new MeshProposalError(
        MESH_PROPOSAL_SIGNAL_MISMATCH,
        `signal ${signal.signalKey} does not belong to proposal ${id} (${record.signalKey})`,
      );
    }
    if (record.state !== "drafted") {
      // Re-checking a checked/filed/refused record changes
      // nothing: its verdict is its history.
      return record;
    }
    const verdict = evaluateEvidenceBar(signal);
    const next: MeshProposalRecord = {
      ...record,
      evidenceRefs: signal.evidenceRefs,
      barVerdict: verdict,
      state: verdict.passes ? "evidence-checked" : "evidence-refused",
      updatedAtMs: this.now(),
    };
    return this.proposals.save(next);
  }

  /**
   * File an evidence-checked proposal as a §5 issue through the
   * filer seam, and bridge it into the foundation proposal
   * ledger when one is injected. Idempotent: filing a filed
   * record returns it unchanged and files nothing twice.
   */
  async file(id: string): Promise<MeshProposalRecord> {
    const record = await this.mustGet(id);
    if (record.state === "filed") return record;
    if (record.state === "evidence-refused") {
      throw new MeshProposalError(
        MESH_PROPOSAL_EVIDENCE_BAR,
        `proposal ${id} was refused by the evidence bar (${record.barVerdict?.reasons.join("; ") ?? "no verdict recorded"}) and cannot be filed`,
      );
    }
    if (record.state !== "evidence-checked") {
      throw new MeshProposalError(
        MESH_PROPOSAL_NOT_CHECKED,
        `proposal ${id} is ${record.state} — the evidence bar must be checked before filing`,
      );
    }
    if (!this.filer) {
      throw new MeshProposalError(
        MESH_PROPOSAL_NO_FILER,
        "no proposal filer is wired — the pipeline is in library-only posture and filing is unavailable",
      );
    }
    const filed = await this.filer.file(buildProposalIssue(record));
    const next: MeshProposalRecord = {
      ...record,
      state: "filed",
      filedIssueNumber: filed.number,
      filedIssueUrl: filed.url,
      updatedAtMs: this.now(),
    };
    const saved = await this.proposals.save(next);
    if (this.ledger) {
      // The ledger is replay-safe on the id (its propose returns
      // the existing row), so a retried bridge cannot duplicate.
      await this.ledger.propose({
        id: record.id,
        title: record.title,
        summary: record.problem,
        proposerAgent: "mesh-rsi-pipeline",
        principal: "programme-2225",
        createdAtMs: record.createdAtMs,
      });
    }
    return saved;
  }

  private async mustGet(id: string): Promise<MeshProposalRecord> {
    const record = await this.proposals.get(id);
    if (!record) {
      throw new MeshProposalError(
        MESH_PROPOSAL_NOT_FOUND,
        `no mesh proposal record with id ${id}`,
      );
    }
    return record;
  }
}
