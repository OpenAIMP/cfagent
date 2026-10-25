/**
 * Issue #1446 ([AGENTIC] Phase 3, sub-issue of #1362) — job synthesis.
 *
 * Synthesis turns a Phase 2 compiled chain (`CompiledChain` in
 * src/orchestrate.ts) into a schedule/job record behind the scenes.
 * It is record creation ONLY: synthesizing never runs a screen, sends
 * a message, submits a mas_async_jobs row or a shard job, creates a
 * ScheduledAgent goal, or touches the NLQ scheduler. Executing chains
 * is runtime work beyond synthesis; the firing path consumes an
 * APPROVED record later.
 *
 * HARD RULE — HUMAN CONFIRMATION GATE (stop-the-line if violated):
 * a synthesized schedule NEVER goes live without human confirmation.
 * `synthesizeSchedule` always returns status "pending", and the
 * record type carries NO `enabled` field at all — there is nothing
 * to flip by accident. `approveSynthesizedRecord` /
 * `approveSynthesizedInList` is the ONLY transition to "approved",
 * it touches exactly the named record, and `shouldFireSynthesized`
 * returns false for every pending record, even when its cron is due.
 * Synthesis never routes through ScheduledAgent `addGoal` (which
 * defaults `enabled` to true when omitted) and never writes the
 * `goals` list pre-approval.
 *
 * RECONCILIATION DECISION (also recorded in #1446):
 * 1. Schedule substrate — CHOSEN: ScheduledAgent DO goals
 *    (src/agents/scheduled-agent.ts, DO storage). Why: durable,
 *    visible in the schedule dashboard, ticked by worker cron,
 *    budget-checked via PaymentsAgent before dispatch — the only
 *    substrate with a durable goal + budget + dispatch path.
 *    NOT CHOSEN: the NLQ Agents Schedule API
 *    (src/agents/nlq/execution.ts, Cloudflare Agents SDK schedules).
 *    Why not: per-agent SDK schedules (reminders and similar), no
 *    durable goal record, no budget-check or chain-dispatch path,
 *    not visible in the schedule dashboard. Handling of the
 *    non-chosen path: explicitly OUT OF SCOPE — no adapter built
 *    here; a future follow-up may surface approved synthesized
 *    schedules in NLQ listings, but synthesis never writes to the
 *    SDK scheduler.
 * 2. Job model — ONE model, already reconciled on main: mas_async_jobs
 *    rows with `chain_id`/`stage` carrying the #1355 sharded chain
 *    shape. #1355 itself (landed: src/services/shardJobs.ts,
 *    src/services/shardExecutors.ts, asyncJobs.ts chain handling)
 *    states "NO parallel job model lives here: a shard IS a
 *    mas_async_jobs row". Phase 3 re-specifies nothing and invents
 *    no second model. Synthesis submits NO rows and NO shard jobs —
 *    submission is firing/execution, out of scope; the synthesized
 *    record carries the full compiled chain so the firing path can
 *    submit it as a sharded chain without re-derivation.
 * 3. Synthesis record storage — `SynthesizedSchedule` records under
 *    the DO key `synthesizedSchedules`, separate from the `goals`
 *    key. This is the structural gate: the existing firing paths
 *    (`onCron`, `triggerGoal`) read only `goals`, so a pending
 *    record cannot fire through them even if a caller errs.
 *    Existing hazards considered and avoided by design (not defects
 *    fixed here): `addGoal` defaults `enabled` to true when omitted,
 *    and `triggerGoal` deliberately fires disabled goals on manual
 *    operator trigger (documented behavior for shipped-disabled
 *    goals like `daily-social-post`). Synthesis avoids both by never
 *    entering the `goals` list pre-approval and never routing
 *    through `addGoal`; changing those shipped semantics is out of
 *    scope.
 *
 * Follow-up (documented, NOT built here): firing/materialization
 * wiring — an approved recurring record becoming a goals-list entry,
 * an approved one-shot record being submitted as a sharded chain.
 * The firing contract that path must honor is `shouldFireSynthesized`.
 */

import { CAPABILITY_REGISTRY } from "./capabilityRegistry";
import {
  chainDeliveryChannels,
  MAX_CHAIN_STEPS,
  type CompiledChain,
  type CompiledChainStep,
} from "../orchestrate";
import { isDue, isValidCron } from "../schedule";

/** DO storage key for synthesized records — never the `goals` key. */
export const SYNTHESIZED_SCHEDULES_KEY = "synthesizedSchedules";

/**
 * Lifecycle of a synthesized record: pending until a human approves.
 * "killed" is the Phase 6 (#1468) terminal governance status: a killed
 * record never fires (`shouldFireSynthesized` fires ONLY "approved"
 * records, so no predicate change was needed) and can never be
 * approved — see `approveSynthesizedRecord`. The Phase 3 confirmation
 * gate itself is unchanged.
 */
export type SynthesizedStatus = "pending" | "approved" | "killed";

/**
 * A synthesized schedule/job record, derived from a Phase 2 compiled
 * chain. It carries everything the firing path needs (chain, cron,
 * budget cap, delivery channels) and nothing that can fire it: no
 * `enabled` flag, no job id, no scheduler handle.
 */
export interface SynthesizedSchedule {
  id: string;
  goal: string;
  kind: "recurring" | "one-shot";
  steps: CompiledChainStep[];
  /** Cron expression for recurring records; null for one-shot jobs. */
  cron: string | null;
  budgetCents: number;
  budgetCapCents: number | null;
  deliveryChannels: string[];
  reusesStoredReport: boolean;
  status: SynthesizedStatus;
  createdAt: string;
  approvedAt: string | null;
  /** One-shot consumption marker; recurring records use lastRun. */
  firedAt: string | null;
  /** Last firing instant (recurring only), for the due check. */
  lastRun?: string;
  timeZone?: string;
}

function validBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function validTimeZone(timeZone: string | undefined): boolean {
  if (timeZone === undefined || timeZone === "") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Defensive re-validation of a chain at the synthesis boundary: the
 * compiler already guarantees these, but synthesis must not trust a
 * hand-built chain passed in as a CompiledChain. Throws on the first
 * violation. Mirrors the Phase 2 honesty rule: stage is
 * registry-derived, never caller-supplied.
 */
function validateChainForSynthesis(chain: CompiledChain): void {
  if (!chain || typeof chain !== "object") {
    throw new Error("Cannot synthesize: no compiled chain provided.");
  }
  if (typeof chain.goal !== "string" || chain.goal.length === 0) {
    throw new Error("Cannot synthesize: chain goal is empty.");
  }
  if (
    !Array.isArray(chain.steps) ||
    chain.steps.length === 0 ||
    chain.steps.length > MAX_CHAIN_STEPS
  ) {
    throw new Error("Cannot synthesize: chain steps are empty or over the step cap.");
  }
  const seen = new Set<string>();
  const ids = new Set<string>();
  let prevStage = -1;
  const stageOrder = ["feed", "generate", "store", "serve", "deliver"];
  for (const step of chain.steps) {
    if (!step || typeof step.capabilityId !== "string") {
      throw new Error("Cannot synthesize: chain step has no capability id.");
    }
    const entry = CAPABILITY_REGISTRY.find((e) => e.id === step.capabilityId);
    if (!entry) {
      throw new Error(`Unknown chain step capability: ${step.capabilityId}.`);
    }
    if (entry.status !== "shipped" && entry.status !== "in_flight") {
      throw new Error(
        `Chain step ${step.capabilityId} is not usable: registry status is "${entry.status}" (only shipped/in_flight capabilities may be synthesized).`,
      );
    }
    if (step.stage !== entry.stage) {
      throw new Error(
        `Chain step ${step.capabilityId} declares stage "${step.stage}" but the registry says "${entry.stage}".`,
      );
    }
    if (seen.has(step.capabilityId)) {
      throw new Error(`Cannot synthesize: duplicate chain step ${step.capabilityId}.`);
    }
    seen.add(step.capabilityId);
    ids.add(step.id);
    const idx = stageOrder.indexOf(step.stage);
    if (idx < prevStage) {
      throw new Error("Cannot synthesize: chain stages are out of order.");
    }
    prevStage = idx;
  }
  for (const step of chain.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Cannot synthesize: chain step ${step.id} depends on unknown step ${dep}.`);
      }
    }
  }
  if (!validBudget(chain.budgetCents)) {
    throw new Error("Cannot synthesize: chain budget is not a non-negative integer.");
  }
  if (chain.budgetCapCents !== null && chain.budgetCapCents !== undefined) {
    if (!validBudget(chain.budgetCapCents)) {
      throw new Error("Cannot synthesize: chain budget cap is not a non-negative integer.");
    }
    if (chain.budgetCents > chain.budgetCapCents) {
      throw new Error(
        `Cannot synthesize: budget ${chain.budgetCents} exceeds cap ${chain.budgetCapCents}.`,
      );
    }
  }
}

function generateId(): string {
  return `synth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Synthesize a schedule/job record from a compiled chain. ALWAYS
 * returns status "pending" — there is no option, flag, or overload
 * that synthesizes an approved/live record. Recurring chains require
 * a valid cron; one-shot chains must not carry one (a one-shot with
 * a cron would be a recurring schedule by another name).
 */
export function synthesizeSchedule(
  chain: CompiledChain,
  opts: {
    cron?: string | null;
    id?: string;
    timeZone?: string;
    createdAt?: string;
  } = {},
): SynthesizedSchedule {
  validateChainForSynthesis(chain);
  const id = (opts.id ?? "").trim();
  if (opts.id !== undefined && id === "") {
    throw new Error("Cannot synthesize: id must not be empty.");
  }
  if (!validTimeZone(opts.timeZone)) {
    throw new Error(`Cannot synthesize: invalid timeZone: ${opts.timeZone}.`);
  }
  let cron: string | null = null;
  if (chain.recurrence === "recurring") {
    if (typeof opts.cron !== "string" || !isValidCron(opts.cron.trim())) {
      throw new Error(
        "Cannot synthesize: recurring synthesis requires a valid cron expression.",
      );
    }
    cron = opts.cron.trim();
  } else {
    if (opts.cron !== undefined && opts.cron !== null) {
      throw new Error(
        "Cannot synthesize: one-shot synthesis must not carry a cron expression.",
      );
    }
  }
  return {
    id: id || generateId(),
    goal: chain.goal,
    kind: chain.recurrence,
    steps: chain.steps,
    cron,
    budgetCents: chain.budgetCents,
    budgetCapCents: chain.budgetCapCents ?? null,
    deliveryChannels: chainDeliveryChannels(chain),
    reusesStoredReport: chain.reusesStoredReport,
    status: "pending",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    approvedAt: null,
    firedAt: null,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  };
}

/**
 * Approve ONE synthesized record: pending → approved. Already
 * approved records are returned unchanged (idempotent, never
 * duplicated). This is the only transition to live.
 *
 * Phase 6 (#1468): a killed record can NEVER be approved — killed is
 * terminal, so approving it would resurrect a chain the kill switch
 * stopped. The throw keeps the kill terminal without touching the
 * pending → approved gate itself.
 */
export function approveSynthesizedRecord(
  record: SynthesizedSchedule,
  approvedAt?: string,
): SynthesizedSchedule {
  if (record.status === "killed") {
    throw new Error(
      `Cannot approve killed synthesized schedule: ${record.id} — killed is terminal.`,
    );
  }
  if (record.status === "approved") return record;
  return {
    ...record,
    status: "approved",
    approvedAt: approvedAt ?? new Date().toISOString(),
  };
}

/**
 * Approve one record inside a list, by id. Throws on an unknown id;
 * leaves every other record untouched; re-approving an approved
 * record returns the list unchanged.
 */
export function approveSynthesizedInList(
  records: SynthesizedSchedule[],
  id: string,
  approvedAt?: string,
): SynthesizedSchedule[] {
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) {
    throw new Error(`Unknown synthesized schedule: ${id}.`);
  }
  if (records[idx].status === "approved") return records;
  return records.map((r, i) =>
    i === idx ? approveSynthesizedRecord(r, approvedAt) : r,
  );
}

/**
 * The firing contract. False for every pending record — no matter
 * how due its cron is. True only for approved records: recurring
 * ones when their cron is due (and not fired within the due window),
 * one-shot ones exactly until first fired. Any future firing path
 * MUST gate on this predicate; it is the confirmation gate in code.
 */
export function shouldFireSynthesized(
  record: SynthesizedSchedule,
  now: Date,
): boolean {
  if (record.status !== "approved") return false;
  if (record.kind === "one-shot") return record.firedAt === null;
  if (record.cron === null) return false;
  return isDue(record.cron, record.lastRun, now, record.timeZone);
}

/**
 * Lifecycle bookkeeping AFTER a firing (not a firing itself): marks
 * a one-shot record consumed, or stamps a recurring record's lastRun
 * so the due check suppresses re-fire. Throws on pending records —
 * a pending record can never have fired, so marking it is a bug.
 */
export function markSynthesizedFired(
  record: SynthesizedSchedule,
  nowIso: string,
): SynthesizedSchedule {
  if (record.status !== "approved") {
    throw new Error("Cannot mark a pending synthesized schedule as fired.");
  }
  if (record.kind === "one-shot") return { ...record, firedAt: nowIso };
  return { ...record, lastRun: nowIso };
}
