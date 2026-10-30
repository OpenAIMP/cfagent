/**
 * Issue #2346 (#1976 step 3b) — the promotion transition under
 * the transaction aspect (ADR 0022 D-C): sabotage pins, the
 * status re-read pin, refused-wrap pins, and the lying-primitive
 * control.
 *
 * THE PROPERTY UNDER TEST: promote / resolve / rollback are one
 * unit of work on the aspect's DO leg (its first production
 * use). A throw injected at ANY leg — apply (early or late),
 * promotion record, status update — leaves the post-state
 * EXACTLY equal to the pre-state across every table the
 * transition touches. On the unwrapped code these same pins are
 * RED, and the failure diff is precisely the partial state the
 * step-3 audit §3.2 names (applied weights with no promotion
 * record; a record whose challenger still reads evaluated; a
 * gate written with no audit). That red is this slice's Red
 * evidence for the atomicity claim; the characterization suite
 * (companion file) pins the behaviour that must NOT change.
 *
 * FAULT INJECTION is through the sql handle: a proxy whose exec
 * throws when a statement matches the leg's table pattern. The
 * transition functions take (sql, ..., txStorage); setup runs
 * on the clean storage, the sabotaged call runs with the faulty
 * handle plus the real storage, so pre-wrap (no wrap exists)
 * and post-wrap runs execute the identical scenario.
 *
 * RUNNER REGISTRATION mirrors the step-2 conformance suite:
 * the aspect-backed runner is registered for this file and
 * unregistered on teardown (the registry is process-global).
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChallenger,
  recordChallengerApproval,
  promoteChallenger,
  resolveChallengerOutcome,
  rollbackChallengerPromotion,
  getChallenger,
  getActiveStrategySet,
  listPromotionRecords,
  type Challenger,
} from "../src/services/championChallenger";
import {
  applyWeightsV2Targets,
  getStrategyWeightsV2,
  weightsV2Key,
} from "../src/services/strategyWeightsV2";
import { isStrategyGatedOff } from "../src/services/strategyPolicyState";
import {
  getTransactionRunner,
  registerTransactionRunner,
} from "../src/data/transactionRunnerProvider";
import { aspectTransactionRunner } from "../src/data/transactionRunner";
import {
  d1BatchTransactionBackend,
  withTransaction,
  type DoTransactionStorage,
} from "../src/aspects/transactionAspect";
import {
  DataFoundationCode,
  DataFoundationError,
} from "../src/aspects/errorCodes";

beforeAll(() => {
  registerTransactionRunner(aspectTransactionRunner);
});
afterAll(() => {
  // The registry is process-global; other suites in this
  // worker must not inherit the registration.
  registerTransactionRunner(undefined as never);
});

/**
 * SqlStorage-shaped executor over node:sqlite (real semantics),
 * doubling as the storage: `sql` is the storage's own handle
 * (this executor), and `transactionSync` invokes its closure
 * with NO argument — the real facade's shape, as observed by
 * #2348 and implemented by the aspect after #2455 (the pre-fix
 * doubles passed a `{ sql }` argument and are corrected here,
 * semantics unchanged).
 */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
  transactionSync<T>(closure: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * The step-0 lying-primitive control: a transactionSync that
 * runs the closure with NO transaction. Atomicity pins must
 * fail against it — that failure is what proves the pins test
 * the primitive rather than nothing.
 */
class LyingTestStorage extends SqliteTestStorage {
  override transactionSync<T>(closure: () => T): T {
    return closure();
  }
}

/** A store whose primitive refuses the unit outright. */
class RefusingTestStorage extends SqliteTestStorage {
  override transactionSync<T>(_closure: () => T): T {
    throw new DataFoundationError(
      DataFoundationCode.TX_CANNOT_HONOUR,
      "test double: the store cannot honour a unit of work",
    );
  }
}

/**
 * A store that flips the challenger's status after the unit
 * opens and before the wrapped call reads — modelling a status
 * change that lands between the caller's pre-checks and the
 * unit's own read. An implementation that trusts its pre-read
 * status applies anyway; the wrapped one must refuse.
 */
class StatusFlipStorage extends SqliteTestStorage {
  flip: { id: string; status: string } | null = null;
  override transactionSync<T>(closure: () => T): T {
    return super.transactionSync(() => {
      if (this.flip) {
        this.exec(
          `UPDATE mas_challengers SET status = ? WHERE id = ?`,
          this.flip.status,
          this.flip.id,
        );
        this.flip = null;
      }
      return closure();
    });
  }
}

/** Fault-injecting sql handle: throws when a statement matches. */
class FaultySql {
  constructor(
    private readonly inner: SqliteTestStorage,
    private readonly pattern: RegExp,
    private readonly label: string,
  ) {}
  exec(query: string, ...params: unknown[]): unknown[] {
    if (this.pattern.test(query)) {
      throw new Error(`sabotage ${this.label}: ${query.slice(0, 80)}`);
    }
    return this.inner.exec(query, ...params);
  }
}

const NOW = new Date("2026-10-29T12:00:00.000Z");
const OWNER = "owner-mubasher";
const CRITERIA = { minHoldoutEdge: 0.0005, minEvaluated: 1 };

const STATE_TABLES = [
  "mas_challengers",
  "mas_challenger_approvals",
  "mas_challenger_promotions",
  "mas_strategy_bank_active",
  "mas_strategy_weights_v2",
  "mas_strategy_weight_versions",
  "mas_strategy_gates",
  "mas_strategy_weight_caps",
  "mas_adaptation_audit",
  "mas_settings",
] as const;

function dumpState(sql: SqliteTestStorage): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of STATE_TABLES) {
    const exists = (sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      t,
    ) as Array<{ name: string }>).length > 0;
    out[t] = exists
      ? (sql.exec(`SELECT * FROM ${t} ORDER BY rowid`) as unknown[])
      : [];
  }
  return out;
}

function forceEvaluated(
  sql: SqliteTestStorage,
  challengerId: string,
  verdict: "pass" | "fail",
): void {
  const evaluation = {
    datasetVersion: "v2",
    evaluatedAt: NOW.toISOString(),
    selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 5 },
    holdout: { championScore: 0.1, challengerScore: 0.25, evaluated: 5 },
    verdict,
    criteria: CRITERIA,
  };
  sql.exec(
    `UPDATE mas_challengers SET status = 'evaluated', evaluation_json = ? WHERE id = ?`,
    JSON.stringify(evaluation),
    challengerId,
  );
}

function makeChallenger(
  sql: SqliteTestStorage,
  input: Partial<Parameters<typeof createChallenger>[2]> & {
    verdict?: "pass" | "fail" | null;
  } = {},
): Challenger {
  const { verdict = "pass", ...rest } = input;
  const challenger = createChallenger(sql as never, "alice", {
    kind: "weights",
    title: "Raise iron_condor weight in chop",
    regime: "chop",
    spec: { weights: { iron_condor: 1.4 } },
    criteria: CRITERIA,
    evalSetVersion: "v2",
    sourceProposalId: null,
    createdBy: "research-agent",
    now: NOW,
    ...rest,
  });
  if (verdict !== null) forceEvaluated(sql, challenger.id, verdict);
  const res = recordChallengerApproval(sql as never, "alice", challenger.id, {
    approver: OWNER,
    decision: "approved",
    now: NOW,
  });
  expect(res.ok).toBe(true);
  return challenger;
}

function seedWeight(
  sql: SqliteTestStorage,
  strategy: string,
  regime: string,
  weight: number,
): void {
  const res = applyWeightsV2Targets(
    sql as never,
    [{ strategy, regime, weight }],
    { actor: OWNER, rationale: "tx-pin seed", now: NOW },
  );
  expect(res.halted).toBeFalsy();
}

/* ------------------------------------------------------------------ */
/* Sabotage: promote (weights) — one pin per leg                       */
/* ------------------------------------------------------------------ */

const WEIGHT_WRITE = /INTO\s+mas_strategy_weights_v2/;
const AUDIT_WRITE = /INTO\s+mas_adaptation_audit/;
const RECORD_WRITE = /INTO\s+mas_challenger_promotions/;
const STATUS_WRITE = /UPDATE\s+mas_challengers\s+SET\s+status/;
const ACTIVE_SET_WRITE = /INTO\s+mas_strategy_bank_active/;
const GATE_WRITE = /INTO\s+mas_strategy_gates/;

describe("sabotage #2346: promoteChallenger (weights) is atomic per leg", () => {
  function setup(): { sql: SqliteTestStorage; challenger: Challenger } {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    return { sql, challenger };
  }

  it.each([
    ["apply leg, first weight write", WEIGHT_WRITE],
    ["apply leg, adaptation-audit write after the weight lands", AUDIT_WRITE],
    ["promotion-record leg", RECORD_WRITE],
    ["status leg", STATUS_WRITE],
  ])("throw at %s ⇒ post-state equals pre-state exactly", (_label, pattern) => {
    const { sql, challenger } = setup();
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, pattern, _label);
    expect(() =>
      promoteChallenger(faulty as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    // The named partial states, asserted directly as well:
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.0);
  });

  it("the same sabotage under the LYING primitive leaves the partial state (control)", () => {
    // Step-0 form: if transactionSync does not actually
    // transact, the record-leg sabotage must produce exactly
    // the audit §3.2 partial state — weights applied, no
    // promotion record, challenger still evaluated. This
    // control proves the pins above test the primitive.
    const sql = new LyingTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, RECORD_WRITE, "promotion-record leg");
    expect(() =>
      promoteChallenger(faulty as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).not.toEqual(before);
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
  });
});

describe("sabotage #2346: promoteChallenger (active set) is atomic per leg", () => {
  it.each([
    ["apply leg (append)", ACTIVE_SET_WRITE],
    ["promotion-record leg", RECORD_WRITE],
    ["status leg", STATUS_WRITE],
  ])("throw at %s ⇒ post-state equals pre-state exactly", (_label, pattern) => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      kind: "active_set",
      spec: { activeStrategies: ["iron_condor", "bull_put"] },
    });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, pattern, _label);
    expect(() =>
      promoteChallenger(faulty as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(getActiveStrategySet(sql as never, "alice")).toBeNull();
  });
});

describe("sabotage #2346: resolveChallengerOutcome is atomic per leg", () => {
  it.each([
    ["apply leg (gate write)", GATE_WRITE],
    ["apply leg (adaptation-audit write after the gate lands)", AUDIT_WRITE],
    ["promotion-record leg", RECORD_WRITE],
    ["status leg", STATUS_WRITE],
  ])("retire: throw at %s ⇒ post-state equals pre-state exactly", (_label, pattern) => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, pattern, _label);
    expect(() =>
      resolveChallengerOutcome(faulty as never, "alice", challenger.id, {
        outcome: "retire_strategy",
        actor: OWNER,
        reason: "persistent loser",
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
  });

  it("keep-champion: throw at the status leg ⇒ the record rolls back too", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { verdict: "fail" });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, STATUS_WRITE, "status leg");
    expect(() =>
      resolveChallengerOutcome(faulty as never, "alice", challenger.id, {
        outcome: "keep_champion",
        actor: OWNER,
        reason: "holdout edge too small",
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
  });
});

describe("sabotage #2346: rollbackChallengerPromotion is atomic per leg", () => {
  it.each([
    ["promotion-record leg (restore applied first)", RECORD_WRITE],
    ["status leg", STATUS_WRITE],
  ])("weights rollback: throw at %s ⇒ the promotion stays fully live", (_label, pattern) => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    expect(
      promoteChallenger(sql as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toEqual({ ok: true });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, pattern, _label);
    expect(() =>
      rollbackChallengerPromotion(faulty as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
  });
});

/* ------------------------------------------------------------------ */
/* Wrapped happy paths equal the characterized outcomes                */
/* ------------------------------------------------------------------ */

describe("wrapped path #2346: successful outcomes are the characterized ones", () => {
  it("weights promote under the unit: same records, same statuses", () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    }, sql as never);
    expect(res).toEqual({ ok: true });
    const weights = getStrategyWeightsV2(sql as never);
    expect(weights[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
    expect(weights[weightsV2Key("bull_put", "chop")]).toBe(0.8);
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("promoted");
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });

  it("retire + rollback under the unit restore the gate exactly", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    expect(
      resolveChallengerOutcome(sql as never, "alice", challenger.id, {
        outcome: "retire_strategy",
        actor: OWNER,
        reason: "persistent loser",
        now: NOW,
      }, sql as never),
    ).toEqual({ ok: true });
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(true);
    expect(
      rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never),
    ).toEqual({ ok: true });
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("rolled_back");
  });

  it("a promotion attempted inside an outer runner unit is refused with the typed outcome, applying nothing", async () => {
    // Discovered composition property, pinned as found: the
    // runner constructs a fresh backend instance per call, and
    // the aspect's ambient join is by backend identity — so a
    // runner-wrapped call inside another runner unit is NOT a
    // join; the aspect refuses it as a different-backend unit
    // and this slice's consumer guard surfaces that refusal as
    // TX_CANNOT_HONOUR. Nothing is applied. (True same-instance
    // joins — one backend object, nested withTransaction calls
    // — are pinned by the step-0 proof suite,
    // tests/transaction_proof_2288.test.ts. Production promotion
    // is invoked from route handlers, never inside another
    // runner unit, so the refusal path is unreachable there;
    // if it were reached, it fails honestly and atomically.)
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4 } },
    });
    const before = dumpState(sql);
    let caught: unknown;
    await aspectTransactionRunner.run(
      sql as never as DoTransactionStorage,
      { operationName: "test.outerUnit", domain: "champion-challenger" },
      () => {
        try {
          promoteChallenger(sql as never, "alice", challenger.id, {
            actor: OWNER,
            now: NOW,
          }, sql as never);
        } catch (err) {
          caught = err;
        }
      },
    );
    expect(caught).toBeInstanceOf(DataFoundationError);
    expect((caught as DataFoundationError).code).toBe(
      DataFoundationCode.TX_CANNOT_HONOUR,
    );
    expect(dumpState(sql)).toEqual(before);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
  });
});

/* ------------------------------------------------------------------ */
/* Status re-read inside the unit                                      */
/* ------------------------------------------------------------------ */

describe("status re-read #2346", () => {
  it("promote refuses when the status changed after the pre-checks, applying nothing", () => {
    const sql = new StatusFlipStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4 } },
    });
    // The flip lands when the unit opens: pre-checks read
    // "evaluated"; the unit's own read must see the new status.
    sql.flip = { id: challenger.id, status: "kept_champion" };
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    }, sql as never);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("kept_champion");
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.0);
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("kept_champion");
  });

  it("keep-champion refuses when the status changed after the pre-checks", () => {
    const sql = new StatusFlipStorage();
    const challenger = makeChallenger(sql, { verdict: "fail" });
    sql.flip = { id: challenger.id, status: "promoted" };
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "keep_champion",
      actor: OWNER,
      reason: "holdout edge too small",
      now: NOW,
    }, sql as never);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("promoted");
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });
});

/* ------------------------------------------------------------------ */
/* Refused wraps surface the typed catalog outcome, state untouched    */
/* ------------------------------------------------------------------ */

describe("refused wraps #2346", () => {
  it("a store whose primitive refuses: promote throws TX_CANNOT_HONOUR and writes nothing", () => {
    const sql = new RefusingTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4 } },
    });
    const before = dumpState(sql);
    let caught: unknown;
    try {
      promoteChallenger(sql as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataFoundationError);
    expect((caught as DataFoundationError).code).toBe(
      DataFoundationCode.TX_CANNOT_HONOUR,
    );
    expect(dumpState(sql)).toEqual(before);
  });

  it("cross-backend: a promotion attempted inside a D1 ambient unit is refused, state untouched", async () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4 } },
    });
    const before = dumpState(sql);
    const fakeD1 = {
      prepare: (query: string) => ({
        bind: (...params: unknown[]) => ({ query, params }),
      }),
      batch: async (_statements: unknown[]) => [],
    };
    let caught: unknown;
    await withTransaction(
      d1BatchTransactionBackend(fakeD1),
      { operationName: "test.ambientD1", domain: "champion-challenger" },
      async () => {
        try {
          promoteChallenger(sql as never, "alice", challenger.id, {
            actor: OWNER,
            now: NOW,
          }, sql as never);
        } catch (err) {
          caught = err;
        }
      },
    );
    expect(caught).toBeInstanceOf(DataFoundationError);
    expect((caught as DataFoundationError).code).toBe(
      DataFoundationCode.TX_CANNOT_HONOUR,
    );
    expect(dumpState(sql)).toEqual(before);
  });

  it("async wrapped call on the DO leg is refused by the aspect (seam-level pin)", async () => {
    // The transition itself is synchronous by construction
    // (step-3b async audit: no async function anywhere in the
    // three transitions or their legs), so async refusal is
    // pinned at the runner seam this slice composes — the same
    // property the step-0 proof suite pins on the aspect.
    const sql = new SqliteTestStorage();
    sql.exec(
      `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    await expect(
      aspectTransactionRunner.run(
        sql as never as DoTransactionStorage,
        { operationName: "test.asyncRefusal", domain: "champion-challenger" },
        async () => {
          sql.exec(
            `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
            "k",
            "v",
            NOW.toISOString(),
          );
        },
      ),
    ).rejects.toMatchObject({ code: DataFoundationCode.TX_CANNOT_HONOUR });
    expect(
      sql.exec(`SELECT * FROM mas_settings`) as unknown[],
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Absence discipline (the step-2 contract)                            */
/* ------------------------------------------------------------------ */

describe("absence discipline #2346", () => {
  it("storage without transactionSync: the transition runs sequentially, exactly as before", () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4 } },
    });
    const noTx = sql as unknown as { transactionSync?: unknown };
    const saved = noTx.transactionSync;
    noTx.transactionSync = undefined;
    try {
      const res = promoteChallenger(sql as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never);
      expect(res).toEqual({ ok: true });
      expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
    } finally {
      noTx.transactionSync = saved;
    }
  });

  it("no runner registered: the transition runs sequentially even with a capable storage", () => {
    expect(getTransactionRunner()).not.toBeNull();
    registerTransactionRunner(undefined as never);
    try {
      const sql = new SqliteTestStorage();
      seedWeight(sql, "iron_condor", "chop", 1.0);
      const challenger = makeChallenger(sql, {
        spec: { weights: { iron_condor: 1.4 } },
      });
      const res = promoteChallenger(sql as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, sql as never);
      expect(res).toEqual({ ok: true });
      expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
    } finally {
      registerTransactionRunner(aspectTransactionRunner);
    }
  });
});

/* ------------------------------------------------------------------ */
/* #2455: the production-shaped facade storage                        */
/* ------------------------------------------------------------------ */

/**
 * Production-shaped storage (#2455): a DISTINCT object whose
 * `sql` property is the executor and whose `transactionSync`
 * invokes its closure with NO argument — the DurableObjectStorage
 * shape the hosts actually pass (ctx.storage, with
 * ctx.storage.sql as the executor), unlike SqliteTestStorage
 * above, which doubles as its own executor. Against the pre-fix
 * aspect, runPromotionUnit over this shape never ran the unit:
 * the guard's typed TX_CANNOT_HONOUR is what a promotion attempt
 * produced (demonstrated on the pristine tree). After the fix
 * the transition applies — atomically.
 */
class FacadeTestStorage {
  readonly engine = new SqliteTestStorage();
  readonly sql = this.engine;
  transactionSync<T>(closure: () => T): T {
    return this.engine.transactionSync(closure);
  }
}

describe("#2455 facade shape: promotion through a production-shaped storage", () => {
  function setup() {
    const storage = new FacadeTestStorage();
    const sql = storage.engine;
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    return { storage, sql, challenger };
  }

  it("the transition applies through the wrap: records, weights, status", () => {
    const { storage, sql, challenger } = setup();
    const res = promoteChallenger(storage.sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    }, storage as never);
    expect(res).toEqual({ ok: true });
    const weights = getStrategyWeightsV2(sql as never);
    expect(weights[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
    expect(weights[weightsV2Key("bull_put", "chop")]).toBe(0.8);
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("promoted");
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });

  it("a throw at the promotion-record leg rolls the whole transition back", () => {
    const { storage, sql, challenger } = setup();
    const before = dumpState(sql);
    const faulty = new FaultySql(storage.sql, RECORD_WRITE, "promotion-record leg");
    expect(() =>
      promoteChallenger(faulty as never, "alice", challenger.id, {
        actor: OWNER,
        now: NOW,
      }, storage as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.0);
  });
});
