import { Agent } from "agents";
import type { Env } from "../types";
import type { CompiledChain, CompiledChainStep } from "../orchestrate";
import type { ChainRunResult } from "../mcp/goalChainCommands";
import {
  approveSynthesizedInList,
  markSynthesizedFired,
  SYNTHESIZED_SCHEDULES_KEY,
  synthesizeSchedule as synthesizeChainSchedule,
  type SynthesizedSchedule,
} from "../agentic/jobSynthesis";
import {
  isGovernedHalted,
  killSynthesizedInList,
} from "../agentic/chainGovernance";
import {
  auditBlockedChainFiring,
  auditSuccessfulChainFiring,
  CHAIN_EXECUTE_OPERATION,
  decideChainFiring,
  materializeSynthesizedRecord,
} from "../agentic/chainFiring";
import {
  DEFAULT_SCHEDULES,
  isDue,
  isValidCron,
  zonedDateParts,
  type ScheduledGoal,
  type ScheduleTick,
} from "../schedule";
import { createSocialStoresFromNamespace } from "./social/durableStores";
import { createSocialBriefStoreFromNamespace } from "./social/briefStore";
import {
  createSocialPipelineStoresFromNamespace,
  runSocialDailyPipeline,
  SOCIAL_DAILY_PIPELINE_ID,
} from "./social/pipeline";
import { executeSocialGoal, priorDates } from "./social/goalExecutor";
import {
  deliverPendingApprovals,
  fetchSlackPost,
  type SlackPostFn,
} from "./social/delivery";
import {
  createMemoryDryRunSink,
  type DryRunSink,
  type SocialTransport,
} from "./social/publisher";
import { createFetchSocialTransport } from "./social/liveTransport";
import type { DoNamespaceLike } from "../security/durableKv";

// ScheduledAgent: autonomous trigger for goal-driven agent work.
//
// Wired to Cloudflare Cron Triggers (wrangler.jsonc triggers.crons).
// On each tick it:
//   1. Pulls enabled goals from DO storage
//   2. Checks each goal's cron schedule (isDue)
//   3. Budget-checks via PaymentsAgent before creating work
//   4. Creates an Orchestrator job for due goals within budget
//
// The agent never spends directly — all budget decisions go through
// PaymentsAgent, and all work goes through the orchestrator module.
//
// SCOPE (issue #959, survey item D10): ScheduledAgent is explicitly
// NOT a screening scheduler. Screening schedules (stock screens,
// options analysis, strategy discovery) live in the OrchestratorAgent
// schedule store as the autonomousMarketScreen /
// autonomousOptionsAnalysis / autonomousStrategyDiscovery callbacks,
// created through POST /api/schedules/create and validated by
// src/trading/screeningSchemas.ts. Do not add screening callbacks
// here — this agent's remit is goal evaluations with budget checks
// on the */30 cron, nothing else.
//
// Social posting (issue #1077 Phase 5b slice 1) IS in remit as a goal:
// the seeded "daily-social-post" goal (disabled) runs "social.publish"
// through the social goal executor, not through createJob. The goal's
// cron + timeZone decide when; the executor decides what. The old
// bespoke fire check and parallel social tick were retired with this
// change, so there is exactly one scheduler for social posts.

/** Rebuild the compiled chain a synthesized record was made from. */
function chainFromRecord(record: SynthesizedSchedule): CompiledChain {
  return {
    goal: record.goal,
    steps: record.steps,
    budgetCents: record.budgetCents,
    budgetCapCents: record.budgetCapCents,
    recurrence: record.kind,
    reusesStoredReport: record.reusesStoredReport,
  };
}

/** Shard job ids from an executor run's leg results, in leg order. */
function shardProvenanceOf(run: ChainRunResult): string[] {
  const out: string[] = [];
  for (const leg of run.legs) {
    const result = leg.result as { shardJobIds?: unknown } | undefined;
    if (result && Array.isArray(result.shardJobIds)) {
      for (const id of result.shardJobIds) {
        if (typeof id === "string" && !out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

/**
 * Test/production overrides for onCron. Production passes none: the
 * social brief is read from the durable brief store for the firing
 * date (slice 2); an override here is test-only and wins over the
 * store when one is passed.
 */
export interface ScheduledAgentCronOpts {
  socialBriefProvider?: () => string | null;
  socialTransport?: SocialTransport;
  socialDryRunSink?: DryRunSink;
  /** #1077 Phase 5b slice 3: injected Slack poster for approval-card delivery (tests). Production uses fetch. */
  socialSlackPost?: SlackPostFn;
  /** Force evaluation of a specific goal regardless of cron/enabled state (manual trigger). */
  forceGoalId?: string;
  /**
   * #1517: global-halt state for governed chain firing. A sql
   * (Orchestrator `mas_settings`) is preferred when the caller has
   * one — `isGovernedHalted(sql)` — otherwise pass the halt state
   * the caller already knows. The bare tick carries neither, so it
   * enforces the per-record gates (approved/killed/due) and the
   * budget check; see src/agentic/chainFiring.ts for the disclosed
   * cross-DO halt limitation.
   */
  halted?: boolean;
  /** Sql for the global-halt read + blocked-firing audit (callers with D1 access only). */
  sql?: any;
  /**
   * #1523 (Lane 2): leg executor for governed chain firings
   * (e.g. `createChainLegExecutor` bound to a DO/SQL runtime by
   * the caller that owns it). Absent, the branch keeps lane 1
   * behavior exactly: descriptor only, no legs claimed. Present,
   * legs run AFTER the governed decision and the PaymentsAgent
   * budget check above, and BEFORE the descriptor is created —
   * so a failed run stamps nothing and leaves the goal due.
   */
  chainExecutor?: (step: CompiledChainStep) => Promise<unknown>;
}

export class ScheduledAgent extends Agent<Env> {
  private async getGoals(): Promise<ScheduledGoal[]> {
    const stored = await this.ctx.storage.get<ScheduledGoal[]>("goals");
    if (!stored) {
      await this.ctx.storage.put("goals", DEFAULT_SCHEDULES);
      return DEFAULT_SCHEDULES;
    }
    return stored;
  }

  private async saveGoals(goals: ScheduledGoal[]): Promise<void> {
    await this.ctx.storage.put("goals", goals);
  }

  /** Recent cron ticks, newest first (capped). */
  private async getTicks(): Promise<ScheduleTick[]> {
    const stored = await this.ctx.storage.get<ScheduleTick[]>("tickHistory");
    return stored ?? [];
  }

  private async recordTick(tick: ScheduleTick): Promise<void> {
    const history = await this.getTicks();
    history.unshift(tick);
    await this.ctx.storage.put("tickHistory", history.slice(0, 50));
  }

  /**
   * Cron entrypoint, invoked by the Workers runtime on each
   * triggers.crons tick. Evaluates due goals and dispatches work.
   *
   * Issue #1391: production calls onCron() with 0 arguments across the
   * Durable Object RPC boundary; the agent reads this.env directly.
   * Passing the Worker Env across the DO RPC boundary throws DataCloneError
   * because binding objects cannot be serialized.
   *
   * For backwards compatibility with unit tests, onCron accepts either
   * onCron(), onCron(opts), or onCron(env, opts).
   */
  async onCron(
    envOrOpts?: Env | ScheduledAgentCronOpts,
    maybeOpts?: ScheduledAgentCronOpts,
  ): Promise<ScheduleTick> {
    let env: Env = this.env;
    let opts: ScheduledAgentCronOpts | undefined = maybeOpts;

    if (envOrOpts) {
      if (
        typeof envOrOpts === "object" &&
        ("PAYMENTS_AGENT" in envOrOpts || "SESSION_STORE" in envOrOpts)
      ) {
        env = envOrOpts as Env;
      } else if (!opts) {
        opts = envOrOpts as ScheduledAgentCronOpts;
      }
    }
    const now = new Date();
    const tick: ScheduleTick = {
      timestamp: now.toISOString(),
      goalsEvaluated: 0,
      jobsCreated: 0,
      jobsSkipped: 0,
      errors: [],
    };

    const goals = await this.getGoals();
    // #1517: global-halt state for governed chain goals only; other
    // goals are unaffected. A supplied sql wins over a supplied flag
    // only when the flag is absent — an explicit halted:true is never
    // overridden by a sql read.
    const governedHalted =
      opts?.halted ?? (opts?.sql ? isGovernedHalted(opts.sql) : false);

    for (const goal of goals) {
      const isForced = opts?.forceGoalId === goal.id;
      if (!goal.enabled && !isForced) continue;
      tick.goalsEvaluated++;

      if (!isForced && !isDue(goal.cron, goal.lastRun, now, goal.timeZone)) continue;

      try {
        const paymentsId = env.PAYMENTS_AGENT.idFromName("default");
        const payments = env.PAYMENTS_AGENT.get(paymentsId) as unknown as {
          budgetCheck(req: {
            operation: string;
            amountCents: number;
            agentId?: string;
          }): Promise<{ allowed: boolean; reason?: string }>;
        };
        const budgetOk = await payments.budgetCheck({
          operation: goal.operation,
          amountCents: goal.budgetCents,
        });

        if (!budgetOk.allowed) {
          tick.errors.push(`${goal.id}: budget check rejected: ${budgetOk.reason ?? "disallowed"}`);
          tick.jobsSkipped++;
          continue;
        }

        const rawEnv = env as unknown as Record<string, string | undefined>;
        if (goal.operation.startsWith("pipeline:")) {
          // #1224: a goal whose operation names a pipeline runs
          // ordered stages back-to-back in ONE firing through the
          // pipeline executor, not the single-operation path. The
          // budget check above already ran exactly once for this
          // goal; the pipeline adds no second check, and the one
          // tick entry for this onCron call records the outcome
          // below. Manual triggerGoal runs the same branch (it
          // calls onCron), so cron and manual firings behave
          // identically. Unknown pipeline ids fail closed: the
          // goal stays due, no orchestrator job is created.
          const stores = createSocialPipelineStoresFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          if (!stores) {
            tick.errors.push(`${goal.id}: SESSION_STORE binding unavailable, goal left due`);
            tick.jobsSkipped++;
            continue;
          }
          if (goal.operation !== SOCIAL_DAILY_PIPELINE_ID) {
            tick.errors.push(`${goal.id}: unknown pipeline: ${goal.operation}`);
            tick.jobsSkipped++;
            continue;
          }
          const pipelineResult = await runSocialDailyPipeline({
            env: {
              SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
              SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
              SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
              SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
            },
            tokens: {
              X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
              THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
              FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
              INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
              LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
              LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
            },
            store: stores.store,
            approvals: stores.approvals,
            briefStore: stores.briefStore,
            ledger: stores.ledger,
            nowMs: now.getTime(),
            timeZone: goal.timeZone,
            transport: opts?.socialTransport ?? createFetchSocialTransport(),
            dryRunSink: opts?.socialDryRunSink ?? createMemoryDryRunSink(),
            slackPost: opts?.socialSlackPost,
            slackEnv: rawEnv,
          });
          for (const e of pipelineResult.errors) {
            tick.errors.push(`${goal.id}: ${e}`);
          }
          if (pipelineResult.status === "completed") {
            goal.lastRun = now.toISOString();
            tick.jobsCreated++;
          } else {
            // Skipped (e.g. noBrief) or failed: lastRun untouched,
            // the goal stays due and retries on the next tick. A
            // failed run resumes at the first incomplete stage via
            // the pipeline ledger; a skipped run starts fresh.
            tick.jobsSkipped++;
          }
          continue;
        }

        if (goal.operation === "social.publish") {
          // #1077 Phase 5b slice 1: executed directly, never through
          // createJob (there is no orchestrator job for posting).
          const stores = createSocialStoresFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          if (!stores) {
            tick.errors.push(`${goal.id}: SESSION_STORE binding unavailable, goal left due`);
            tick.jobsSkipped++;
            continue;
          }
          // #1077 Phase 5b slice 2: production reads the firing
          // date's brief from the durable brief store (same
          // SESSION_STORE namespace as the draft/approval stores).
          // A test override still wins when one is passed. A read
          // failure throws into the loop's catch below: the error is
          // recorded and the goal stays due for retry — never a
          // silent publish of nothing, and never stale content.
          // The firing date uses the goal's timeZone (default
          // America/New_York), exactly as buildDailyDrafts derives
          // the draft date, so the brief and the drafts cannot
          // disagree about which day they belong to.
          const briefStore = createSocialBriefStoreFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          const firingDate = zonedDateParts(now.getTime(), goal.timeZone ?? "America/New_York").date;
          const storedBrief = briefStore ? await briefStore.getBrief(firingDate) : null;
          const result = await executeSocialGoal({
            env: {
              SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
              SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
              SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
              SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
            },
            tokens: {
              X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
              THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
              FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
              INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
              LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
              LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
            },
            store: stores.ledger,
            approvals: stores.approvals,
            briefProvider: opts?.socialBriefProvider ?? (() => storedBrief),
            nowMs: now.getTime(),
            timeZone: goal.timeZone,
            transport: opts?.socialTransport ?? createFetchSocialTransport(),
            dryRunSink: opts?.socialDryRunSink ?? createMemoryDryRunSink(),
          });
          if (!result.fired) {
            // lastRun untouched: the goal stays due and retries on the
            // next tick (noBrief, posting off, or no drafts produced).
            // #1077 Phase 5b slice 3: delivery still runs below for a
            // not-fired tick (except posting disabled) — delivery is
            // independent of the day's brief, and a noBrief tick can
            // still carry undelivered backlog.
            if (isForced || (result.reason && result.reason !== "noBrief")) {
              tick.errors.push(`${goal.id}: skipped (${result.reason ?? "not fired"})`);
            }
            tick.jobsSkipped++;
          } else {
            for (const r of result.publish.results) {
              if (r.outcome === "error") {
                tick.errors.push(`${goal.id}: ${r.channel}: ${r.reason}`);
              }
            }
            for (const entry of result.catchUp) {
              for (const r of entry.results) {
                if (r.outcome === "error") {
                  tick.errors.push(`${goal.id}: catch-up ${entry.date} ${r.channel}: ${r.reason}`);
                }
              }
            }
            goal.lastRun = now.toISOString();
            tick.jobsCreated++;
          }
          // #1077 Phase 5b slice 3: approval-card delivery pass.
          // Runs after the goal execution on every social tick except
          // posting-disabled (the kill switch gates delivery too),
          // over the firing date plus the catch-up lookback, so a
          // card recorded late in the day is still delivered that
          // night. Idempotent per (date, channel, draftId): a second
          // pass skips already-delivered records. Delivery failures
          // are tick errors — non-fatal, never unfiring the goal —
          // and the undelivered record retries on the next pass.
          // When NO Slack destination is configured at all (neither
          // webhook nor bot token), the pass is skipped silently:
          // Slack delivery is opt-in by configuration, and the
          // session-gated route remains the approval path. A
          // configured destination that fails DOES record errors.
          const slackConfigured = rawEnv.SLACK_WEBHOOK_URL || rawEnv.SLACK_BOT_TOKEN;
          if (slackConfigured && (result.fired || result.reason !== "postingDisabled")) {
            const deliveries = await deliverPendingApprovals({
              store: stores.ledger,
              approvals: stores.approvals,
              dates: [firingDate, ...priorDates(firingDate)],
              post: opts?.socialSlackPost ?? fetchSlackPost,
              env: rawEnv,
            });
            for (const d of deliveries) {
              if (d.error) {
                tick.errors.push(`${goal.id}: slack delivery ${d.channel} ${d.date}: ${d.error}`);
              }
            }
          }
          continue;
        }

        if (goal.operation === CHAIN_EXECUTE_OPERATION) {
          // #1517 (Lane 1) + #1523 (Lane 2): a materialized chain
          // goal fires ONLY through the governed decision. The
          // budget check above already ran for this goal; this
          // branch adds the record lookup + governed gate, then —
          // when the caller supplied a leg executor — runs the
          // chain's legs for real BEFORE any job descriptor is
          // created. A failed run stamps nothing and leaves the
          // goal due; a successful run creates the descriptor
          // exactly like every other goal, stamps goal + record
          // so the due window fires once, and (with sql) writes
          // the #755 success audit lane 1 left open. No executor
          // supplied = lane 1 behavior exactly: descriptor only,
          // no legs claimed. Ordering note: legs run before the
          // descriptor, so a descriptor-creation failure after a
          // successful run leaves the legs run but unstamped —
          // the tick error names it, and the next tick retries.
          const records = await this.getSynthesized();
          const record = records.find((r) => r.id === goal.id);
          if (!record) {
            tick.errors.push(
              `${goal.id}: no synthesized record for chain goal — refusing to fire, goal left due`,
            );
            tick.jobsSkipped++;
            continue;
          }
          const decision = decideChainFiring(record, now, {
            halted: governedHalted,
          });
          if (!decision.fire) {
            tick.errors.push(
              `${goal.id}: chain firing blocked (${decision.reason})`,
            );
            if (opts?.sql) {
              try {
                auditBlockedChainFiring(opts.sql, record, decision.reason, now);
              } catch (err) {
                tick.errors.push(
                  `${goal.id}: blocked-firing audit failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            tick.jobsSkipped++;
            continue;
          }
          let runResult: ChainRunResult | null = null;
          if (opts?.chainExecutor) {
            runResult = await this.executeChainForRecord(
              chainFromRecord(record),
              opts.chainExecutor,
            );
            if (!runResult.ok) {
              const failed = runResult.legs.filter(
                (l) => l.status === "failed" || l.status === "blocked",
              );
              tick.errors.push(
                `${goal.id}: chain execution failed (${failed
                  .map((l) => `${l.capabilityId}: ${l.detail}`)
                  .join("; ")})`,
              );
              tick.jobsSkipped++;
              continue;
            }
          }
          const { createJob } = await import("../orchestrate");
          await createJob(env, {
            goalId: goal.id,
            goalName: goal.name,
            operation: goal.operation,
            budgetCents: goal.budgetCents,
          });
          await this.saveSynthesized(
            records.map((r) =>
              r.id === record.id
                ? markSynthesizedFired(r, now.toISOString())
                : r,
            ),
          );
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          // Success audit only when every leg completed or was
          // submitted to the rails: a run with unimplemented legs
          // (e.g. deliver awaiting the serve hook) has no complete
          // outcome to attest yet, so no row is written for it.
          if (runResult && opts?.sql && runResult.legs.every(
            (l) => l.status === "completed" || l.status === "submitted",
          )) {
            try {
              auditSuccessfulChainFiring(
                opts.sql,
                record,
                shardProvenanceOf(runResult),
                now,
              );
            } catch (err) {
              tick.errors.push(
                `${goal.id}: success audit failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          continue;
        }

        const { createJob } = await import("../orchestrate");
        await createJob(env, {
          goalId: goal.id,
          goalName: goal.name,
          operation: goal.operation,
          budgetCents: goal.budgetCents,
        });

        goal.lastRun = now.toISOString();
        tick.jobsCreated++;
      } catch (err) {
        tick.errors.push(
          `${goal.id}: ${err instanceof Error ? err.message : String(err)}`
        );
        tick.jobsSkipped++;
      }
    }

    await this.saveGoals(goals);
    await this.recordTick(tick);
    return tick;
  }

  /** List all scheduled goals. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.getGoals();
  }

  /** Recent cron tick history, newest first. */
  async getTickHistory(limit: number = 20): Promise<ScheduleTick[]> {
    const history = await this.getTicks();
    return history.slice(0, Math.max(1, Math.min(50, limit)));
  }

  /**
   * Add a new scheduled goal. The operation must exist in the
   * orchestrate.ts catalog; the cron expression uses five fields with
   * lists, ranges, and steps in every field ("0 9 * * 1-5"). An
   * optional IANA timeZone reads the cron wall-clock in that zone;
   * without one the historical UTC behavior applies.
   */
  async addGoal(goal: {
    id: string;
    name: string;
    cron: string;
    operation: string;
    budgetCents: number;
    enabled?: boolean;
    timeZone?: string;
  }): Promise<ScheduledGoal> {
    const id = goal.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!id) throw new Error("Goal id is required.");
    if (!goal.name.trim()) throw new Error("Goal name is required.");
    if (!isValidCron(goal.cron.trim())) {
      throw new Error("Cron must look like 'minute hour * * *' (e.g. '0 6 * * *').");
    }
    let timeZone: string | undefined;
    if (goal.timeZone !== undefined && goal.timeZone !== "") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: goal.timeZone });
        timeZone = goal.timeZone;
      } catch {
        throw new Error(`Invalid timeZone: ${goal.timeZone}`);
      }
    }
    if (!Number.isFinite(goal.budgetCents) || goal.budgetCents <= 0) {
      throw new Error("budgetCents must be a positive number.");
    }
    const goals = await this.getGoals();
    if (goals.some((g) => g.id === id)) throw new Error(`Goal already exists: ${id}`);
    const { OPERATION_CATALOG } = await import("../orchestrate");
    const known = OPERATION_CATALOG.some((e) => e.operations.includes(goal.operation));
    if (!known) throw new Error(`Unknown operation: ${goal.operation}`);
    const created: ScheduledGoal = {
      id,
      name: goal.name.trim(),
      cron: goal.cron.trim(),
      operation: goal.operation,
      budgetCents: Math.floor(goal.budgetCents),
      enabled: goal.enabled !== false,
      ...(timeZone ? { timeZone } : {}),
    };
    goals.push(created);
    await this.saveGoals(goals);
    return created;
  }

  /** Remove a scheduled goal by ID. */
  async removeGoal(id: string): Promise<boolean> {
    const goals = await this.getGoals();
    const idx = goals.findIndex((g: ScheduledGoal) => g.id === id);
    if (idx < 0) return false;
    goals.splice(idx, 1);
    await this.saveGoals(goals);
    return true;
  }

  /** Enable or disable a goal by ID. */
  async setGoalEnabled(id: string, enabled: boolean): Promise<boolean> {
    const goals = await this.getGoals();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    await this.saveGoals(goals);
    return true;
  }

  /**
   * Issue #1446 ([AGENTIC] Phase 3): synthesized-schedule storage.
   *
   * Synthesized records live under the `synthesizedSchedules` DO key,
   * NEVER under the `goals` key — `onCron`/`triggerGoal` read only
   * `goals`, so a pending (or approved-but-unmaterialized) record
   * structurally cannot fire through the existing paths. Approval
   * still creates no goals-list entry; the ONLY path from an
   * approved record to a goals-list entry is the explicit
   * `materializeSynthesizedSchedule` below (#1517, Lane 1).
   */
  private async getSynthesized(): Promise<SynthesizedSchedule[]> {
    const stored =
      await this.ctx.storage.get<SynthesizedSchedule[]>(
        SYNTHESIZED_SCHEDULES_KEY,
      );
    return stored ?? [];
  }

  private async saveSynthesized(
    records: SynthesizedSchedule[],
  ): Promise<void> {
    await this.ctx.storage.put(SYNTHESIZED_SCHEDULES_KEY, records);
  }

  /** List all synthesized schedule/job records (pending + approved). */
  async listSynthesizedSchedules(): Promise<SynthesizedSchedule[]> {
    return this.getSynthesized();
  }

  /**
   * Synthesize a schedule/job record from a compiled chain. Always
   * pending (see src/agentic/jobSynthesis.ts — the confirmation
   * gate); duplicate ids are rejected.
   */
  async synthesizeSchedule(
    chain: CompiledChain,
    opts: { cron?: string | null; id?: string; timeZone?: string },
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const record = synthesizeChainSchedule(chain, opts);
    if (records.some((r) => r.id === record.id)) {
      throw new Error(`Synthesized schedule already exists: ${record.id}`);
    }
    records.push(record);
    await this.saveSynthesized(records);
    return record;
  }

  /**
   * Approve one synthesized record (pending → approved). The ONLY
   * transition to live; unknown ids throw; re-approving is a no-op.
   */
  async approveSynthesizedSchedule(
    id: string,
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const updated = approveSynthesizedInList(records, id);
    await this.saveSynthesized(updated);
    return updated.find((r) => r.id === id)!;
  }

  /**
   * Kill one synthesized record (pending/approved → killed). Phase 6
   * (#1468): killed is terminal and the record never fires
   * (`shouldFireSynthesized` fires ONLY approved records); killing
   * removes nothing, so killed schedules stay enumerable via
   * `listSynthesizedSchedules` and auditable. Unknown ids throw;
   * re-killing is a no-op.
   */
  async killSynthesizedSchedule(
    id: string,
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const updated = killSynthesizedInList(records, id);
    await this.saveSynthesized(updated);
    return updated.find((r) => r.id === id)!;
  }

  /**
   * Issue #1517 (Lane 1): materialize ONE approved recurring record
   * as a goals-list entry. The ONLY transition from synthesized
   * record to schedulable goal: approval alone creates nothing (see
   * above), and this method refuses pending, killed, and one-shot
   * records via `materializeSynthesizedRecord`. Idempotent: a
   * goal already materialized for this id is returned unchanged,
   * never duplicated; a goal id already used by a non-chain goal
   * throws. Materializing creates no job, no async-job row, and no
   * shard job — the goal fires later, through the governed `onCron`
   * branch, when its cron is due.
   */
  async materializeSynthesizedSchedule(
    id: string,
  ): Promise<ScheduledGoal> {
    const records = await this.getSynthesized();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Unknown synthesized schedule: ${id}.`);
    }
    const goals = await this.getGoals();
    const existing = goals.find((g) => g.id === id);
    if (existing) {
      if (existing.operation !== CHAIN_EXECUTE_OPERATION) {
        throw new Error(`Goal id already exists for a non-chain goal: ${id}`);
      }
      return existing;
    }
    const goal = materializeSynthesizedRecord(record);
    goals.push(goal);
    await this.saveGoals(goals);
    return goal;
  }

  /**
   * Run a record's chain through a caller-supplied leg executor.
   * The caller (onCron branch / fireSynthesizedSchedule) already
   * ran the governed decision and the PaymentsAgent budget check,
   * so `runChain`'s per-leg budgetCheck passes through here — it
   * must not re-gate work that is already approved and checked.
   */
  private async executeChainForRecord(
    chain: CompiledChain,
    chainExecutor: (step: CompiledChainStep) => Promise<unknown>,
  ): Promise<ChainRunResult> {
    const { runChain } = await import("../mcp/goalChainCommands");
    return runChain(chain, {
      executeLeg: chainExecutor,
      budgetCheck: async () => true,
    });
  }

  /**
   * Issue #1517 (Lane 1) + #1523 (Lane 2): fire ONE one-shot
   * synthesized record directly. Recurring records are refused
   * here — they must materialize first and fire via `onCron`, so
   * there is exactly one firing path per kind. The governed
   * decision runs before the PaymentsAgent budget check and
   * before any job descriptor is created; a blocked or
   * budget-rejected firing consumes nothing and leaves `firedAt`
   * unset, so it can be retried. With a supplied leg executor,
   * legs run after the budget check and before the descriptor —
   * an executor failure likewise consumes nothing. A successful
   * firing consumes the record (`firedAt` set) and returns the
   * job descriptor id plus the run result.
   */
  async fireSynthesizedSchedule(
    id: string,
    opts?: {
      halted?: boolean;
      sql?: any;
      chainExecutor?: (step: CompiledChainStep) => Promise<unknown>;
    },
  ): Promise<{
    fired: boolean;
    reason: string;
    jobId?: string;
    record: SynthesizedSchedule;
    execution?: ChainRunResult;
  }> {
    const records = await this.getSynthesized();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Unknown synthesized schedule: ${id}.`);
    }
    if (record.kind !== "one-shot") {
      throw new Error(
        `Cannot fire synthesized schedule ${id} directly: recurring records must materialize first and fire via onCron (materializeSynthesizedSchedule).`,
      );
    }
    const now = new Date();
    const halted = opts?.halted ?? (opts?.sql ? isGovernedHalted(opts.sql) : false);
    const decision = decideChainFiring(record, now, { halted });
    if (!decision.fire) {
      if (opts?.sql) {
        try {
          auditBlockedChainFiring(opts.sql, record, decision.reason, now);
        } catch {
          /* Blocked already; an audit failure must not unblock it. */
        }
      }
      return { fired: false, reason: decision.reason, record };
    }
    const paymentsId = this.env.PAYMENTS_AGENT.idFromName("default");
    const payments = this.env.PAYMENTS_AGENT.get(paymentsId) as unknown as {
      budgetCheck(req: {
        operation: string;
        amountCents: number;
        agentId?: string;
      }): Promise<{ allowed: boolean; reason?: string }>;
    };
    const budgetOk = await payments.budgetCheck({
      operation: CHAIN_EXECUTE_OPERATION,
      amountCents: record.budgetCents,
    });
    if (!budgetOk.allowed) {
      return {
        fired: false,
        reason: `budget check rejected: ${budgetOk.reason ?? "disallowed"}`,
        record,
      };
    }
    let execution: ChainRunResult | undefined;
    if (opts?.chainExecutor) {
      execution = await this.executeChainForRecord(
        chainFromRecord(record),
        opts.chainExecutor,
      );
      if (!execution.ok) {
        const failed = execution.legs.filter(
          (l) => l.status === "failed" || l.status === "blocked",
        );
        return {
          fired: false,
          reason: `chain execution failed: ${failed
            .map((l) => `${l.capabilityId}: ${l.detail}`)
            .join("; ")}`,
          record,
          execution,
        };
      }
    }
    const { createJob } = await import("../orchestrate");
    const job = await createJob(this.env, {
      goalId: record.id,
      goalName: record.goal,
      operation: CHAIN_EXECUTE_OPERATION,
      budgetCents: record.budgetCents,
    });
    const updated = markSynthesizedFired(record, now.toISOString());
    await this.saveSynthesized(
      records.map((r) => (r.id === id ? updated : r)),
    );
    if (
      execution &&
      opts?.sql &&
      execution.legs.every(
        (l) => l.status === "completed" || l.status === "submitted",
      )
    ) {
      try {
        auditSuccessfulChainFiring(
          opts.sql,
          record,
          shardProvenanceOf(execution),
          now,
        );
      } catch {
        /* Firing stands; an audit failure must not unconsume it. */
      }
    }
    return {
      fired: true,
      reason: decision.reason,
      jobId: job.jobId,
      record: updated,
      execution,
    };
  }

  /**
   * Manually trigger evaluation of a single goal.
   *
   * Issue #1391:
   * 1. env is optional over the DO RPC boundary; if omitted, reads this.env.
   * 2. Evaluates the goal even if it is currently disabled (e.g. daily-social-post
   *    shipped disabled by default). It temporarily enables the goal in storage
   *    for this firing, and restores its original enabled state afterwards so
   *    that the daily recurring schedule remains disabled.
   */
  async triggerGoal(id: string, env?: Env): Promise<ScheduleTick> {
    const goals = await this.getGoals();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) {
      return {
        timestamp: new Date().toISOString(),
        goalsEvaluated: 0,
        jobsCreated: 0,
        jobsSkipped: 1,
        errors: [`Goal not found: ${id}`],
      };
    }
    const origLastRun = goal.lastRun;
    const targetEnv =
      env && typeof env === "object" && ("PAYMENTS_AGENT" in env || "SESSION_STORE" in env)
        ? env
        : this.env;

    const tick = await this.onCron(targetEnv, { forceGoalId: id });
    if (tick.jobsCreated === 0 && tick.errors.length === 0) {
      const currentGoals = await this.getGoals();
      const currentGoal = currentGoals.find((g: ScheduledGoal) => g.id === id);
      if (currentGoal) {
        currentGoal.lastRun = origLastRun;
        await this.saveGoals(currentGoals);
      }
    }
    return tick;
  }
}
