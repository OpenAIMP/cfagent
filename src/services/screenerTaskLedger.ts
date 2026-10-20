/**
 * Issue #607 — durable task records for screener runs (phase-2 P2-3.1;
 * transformation mandate §6; design: docs/agents/agentic-architecture.md
 * §5/§7). Mirrors the research task ledger (#577) for the screener's
 * storage world: ScreenerAgent persists via the Durable Object
 * storage API (ctx.storage get/put/list) — not Cloudflare KV, and not
 * the DO SQLite API ResearchAgent uses — so this store interface is async.
 *
 * One record per runScreen execution — manual, scheduled, and every
 * runSharded shard (shards call runScreen) — tracking the run
 * independently of its result blob: explicit lifecycle, idempotency
 * dedup for scheduled slots, the run's timestamp identity, counts, a
 * deterministic honesty evaluation, escalation on failure, and a
 * cancelled record when a scheduled duplicate is suppressed. The task
 * id is the durable identity screener runs otherwise lack (results
 * are identified only by timestamp).
 *
 * SDK-free: storage is injected, so the agent (DO storage) and tests
 * (in-memory) share this exact code. Claiming is safe because the
 * owning DO instance is serialized per account.
 */

export type ScreenerTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "escalated"
  | "cancelled";

export interface ScreenerTaskTransition {
  status: ScreenerTaskStatus;
  at: string;
  note?: string;
}

export interface ScreenerTaskEvaluationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ScreenerTaskEvaluation {
  /** Deterministic verdict — never a model's self-assessment. */
  verdict: "pass" | "fail";
  evaluatedAt: string;
  checks: ScreenerTaskEvaluationCheck[];
}

export interface ScreenerTask {
  id: string;
  idempotencyKey: string;
  trigger: "manual" | "scheduled";
  universe: string;
  sector: string;
  userLogin?: string;
  status: ScreenerTaskStatus;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  /** The run's own identity: its result timestamp. */
  runTimestamp?: string;
  totalScanned?: number;
  matchedCount?: number;
  opportunitiesCount?: number;
  /** The run completed on an incomplete quote set (issue #462). */
  partial?: boolean;
  error?: string;
  evaluation?: ScreenerTaskEvaluation;
  history: ScreenerTaskTransition[];
}

export interface ScreenerTaskStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

export interface ScreenerOutcomeFacts {
  success: boolean;
  runTimestamp?: string | null;
  totalScanned?: number | null;
  matchedCount?: number | null;
  opportunities?: number | null;
  partial: boolean;
  qualificationPresent: boolean;
  error?: string | null;
}

const TASK_PREFIX = "task:";
const IDEM_PREFIX = "idem:";
const ACTIVE: ReadonlySet<ScreenerTaskStatus> = new Set(["queued", "claimed", "running"]);

/**
 * Deterministic honesty evaluation for a finished screener run.
 * Encodes the repo's own rules — notably #462: zero quotes must fail
 * honestly (a zero-scan "success" is not a screen), and a partial run
 * must carry its qualification. A properly recorded failure (with an
 * error) evaluates as consistent: the verdict judges the record, and
 * it is never a model grading itself (mandate §9/§14).
 */
export function evaluateScreenerOutcome(
  facts: ScreenerOutcomeFacts,
  evaluatedAt: string
): ScreenerTaskEvaluation {
  const scanned = facts.totalScanned ?? null;
  const matched = facts.matchedCount ?? null;
  const opps = facts.opportunities ?? null;
  const countsPresent =
    typeof scanned === "number" && typeof matched === "number" && typeof opps === "number";
  const checks: ScreenerTaskEvaluationCheck[] = [
    {
      name: "result_present",
      ok: typeof facts.runTimestamp === "string" && facts.runTimestamp.length > 0,
      detail: facts.runTimestamp ? `run at ${facts.runTimestamp}` : "no run timestamp",
    },
    {
      name: "counts_sane",
      ok:
        countsPresent &&
        scanned! >= 0 &&
        matched! >= 0 &&
        opps! >= 0 &&
        matched! <= scanned! &&
        opps! <= matched!,
      detail: `scanned=${scanned ?? "?"} matched=${matched ?? "?"} opportunities=${opps ?? "?"}`,
    },
    {
      name: "success_honest",
      ok: !facts.success || (typeof scanned === "number" && scanned > 0),
      detail: facts.success
        ? scanned && scanned > 0
          ? `success with ${scanned} scanned`
          : "success claimed with zero scanned — zero quotes must fail honestly (#462)"
        : "run recorded as failure",
    },
    {
      name: "partial_qualified",
      ok: !facts.partial || facts.qualificationPresent,
      detail: facts.partial
        ? facts.qualificationPresent
          ? "partial run carries its qualification"
          : "partial run is missing its qualification"
        : "run was not partial",
    },
    {
      name: "error_consistent",
      ok: facts.success
        ? true
        : typeof facts.error === "string" && facts.error.length > 0,
      detail: facts.success
        ? "successful run needs no error"
        : facts.error
          ? `failure carries error: ${facts.error}`
          : "failure result without an error message",
    },
  ];
  return {
    verdict: checks.every((c) => c.ok) ? "pass" : "fail",
    evaluatedAt,
    checks,
  };
}

export class ScreenerTaskLedger {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(
    private readonly store: ScreenerTaskStore,
    opts?: { now?: () => string; newId?: () => string }
  ) {
    this.now = opts?.now ?? (() => new Date().toISOString());
    this.newId =
      opts?.newId ??
      (() =>
        `stask-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
  }

  /**
   * Create a task, or return the existing *active* task for the same
   * idempotency key (created: false). Scheduled runs key on their
   * minute slot, so a duplicate delivery shares one record.
   */
  async create(input: {
    trigger: "manual" | "scheduled";
    universe: string;
    sector: string;
    userLogin?: string;
    idempotencyKey: string;
  }): Promise<{ task: ScreenerTask; created: boolean }> {
    const existingId = await this.store.get(IDEM_PREFIX + input.idempotencyKey);
    if (existingId) {
      const existing = await this.get(existingId);
      if (existing && ACTIVE.has(existing.status)) {
        return { task: existing, created: false };
      }
    }
    const at = this.now();
    const task: ScreenerTask = {
      id: this.newId(),
      idempotencyKey: input.idempotencyKey,
      trigger: input.trigger,
      universe: input.universe,
      sector: input.sector,
      userLogin: input.userLogin,
      status: "queued",
      createdAt: at,
      updatedAt: at,
      heartbeatAt: at,
      history: [{ status: "queued", at }],
    };
    await this.save(task);
    await this.store.set(IDEM_PREFIX + input.idempotencyKey, task.id);
    return { task, created: true };
  }

  async get(id: string): Promise<ScreenerTask | null> {
    const raw = await this.store.get(TASK_PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ScreenerTask;
    } catch {
      return null;
    }
  }

  /** Most recent first. */
  async list(limit = 50): Promise<ScreenerTask[]> {
    const out: ScreenerTask[] = [];
    for (const { value } of await this.store.list(TASK_PREFIX)) {
      try {
        out.push(JSON.parse(value) as ScreenerTask);
      } catch {
        // Skip a corrupt record rather than failing the whole listing.
      }
    }
    return out
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  async claim(id: string): Promise<ScreenerTask> {
    return this.transition(id, ["queued"], "claimed");
  }

  async start(id: string): Promise<ScreenerTask> {
    return this.transition(id, ["claimed"], "running");
  }

  async heartbeat(id: string): Promise<ScreenerTask> {
    const task = await this.load(id);
    if (task.status !== "claimed" && task.status !== "running") {
      throw new Error(`Screener task ${id} cannot heartbeat from status ${task.status}`);
    }
    task.heartbeatAt = this.now();
    task.updatedAt = task.heartbeatAt;
    await this.save(task);
    return task;
  }

  async complete(
    id: string,
    outcome: {
      runTimestamp: string;
      totalScanned: number;
      matchedCount: number;
      opportunitiesCount: number;
      partial: boolean;
      evaluation: ScreenerTaskEvaluation;
    }
  ): Promise<ScreenerTask> {
    const task = await this.transition(id, ["running"], "completed");
    task.runTimestamp = outcome.runTimestamp;
    task.totalScanned = outcome.totalScanned;
    task.matchedCount = outcome.matchedCount;
    task.opportunitiesCount = outcome.opportunitiesCount;
    task.partial = outcome.partial;
    task.evaluation = outcome.evaluation;
    await this.save(task);
    return task;
  }

  async fail(id: string, error: string): Promise<ScreenerTask> {
    const task = await this.transition(id, ["claimed", "running"], "failed", error);
    task.error = error;
    await this.save(task);
    return task;
  }

  async escalate(id: string, reason: string): Promise<ScreenerTask> {
    const task = await this.transition(id, ["failed"], "escalated", reason);
    task.error = task.error ? `${task.error} | escalated: ${reason}` : reason;
    await this.save(task);
    return task;
  }

  /** Terminal for work that will not run (e.g. a suppressed duplicate). */
  async cancel(id: string, note?: string): Promise<ScreenerTask> {
    return this.transition(id, ["queued", "claimed", "running"], "cancelled", note);
  }

  private async load(id: string): Promise<ScreenerTask> {
    const task = await this.get(id);
    if (!task) throw new Error(`Screener task ${id} not found`);
    return task;
  }

  private async transition(
    id: string,
    from: ScreenerTaskStatus[],
    to: ScreenerTaskStatus,
    note?: string
  ): Promise<ScreenerTask> {
    const task = await this.load(id);
    if (!from.includes(task.status)) {
      throw new Error(`Screener task ${id} cannot move from ${task.status} to ${to}`);
    }
    const at = this.now();
    task.status = to;
    task.updatedAt = at;
    task.heartbeatAt = at;
    task.history.push(note ? { status: to, at, note } : { status: to, at });
    await this.save(task);
    return task;
  }

  private async save(task: ScreenerTask): Promise<void> {
    await this.store.set(TASK_PREFIX + task.id, JSON.stringify(task));
  }
}
