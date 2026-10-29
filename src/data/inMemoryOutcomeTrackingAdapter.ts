/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the outcome-tracking port, with semantics identical to
 * the DO-SQLite adapter (append-only events, global per-
 * tenant seq, first terminal stands, the joined path through
 * the injected goal/scenario port).
 */
import type { GoalScenarioStore } from "./goalScenarioPorts";
import {
  summarizeTrackingEvents,
  type OutcomeTrackingStore,
  type OutcomeTrackingSummary,
  type OutcomesPathEntry,
  type RecordOutcomeTerminalInput,
  type StartOutcomeTrackingInput,
  type TrackingEvent,
} from "./outcomeTrackingPorts";
import type { TrackRecord } from "../services/researchTrackRecord";

export class InMemoryOutcomeTrackingStore implements OutcomeTrackingStore {
  private eventsByLogin = new Map<string, TrackingEvent[]>();

  constructor(private readonly goals: GoalScenarioStore) {}

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  private readEvents(userLogin: string): TrackingEvent[] {
    return [...(this.eventsByLogin.get(userLogin) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  private appendEvent(userLogin: string, event: TrackingEvent): void {
    const list = this.eventsByLogin.get(userLogin) ?? [];
    list.push(structuredClone(event));
    this.eventsByLogin.set(userLogin, list);
  }

  private summaryFor(
    userLogin: string,
    recommendationRef: string,
  ): OutcomeTrackingSummary | null {
    const events = this.readEvents(userLogin).filter(
      (e) => e.recommendationRef === recommendationRef
    );
    return summarizeTrackingEvents(events);
  }

  start(userLogin: string, input: StartOutcomeTrackingInput): OutcomeTrackingSummary | null {
    const existing = this.summaryFor(userLogin, input.recommendationRef);
    if (existing) return existing;

    const outcome = this.goals.listOutcomes(userLogin).find(
      (o) => o.recommendationRef === input.recommendationRef
    );
    if (!outcome) return null;

    const now = input.now ?? new Date();
    const provenance = {
      screenRunRef: input.screenRunRef ?? outcome.screenRunRef ?? null,
      goalId: input.goalId ?? outcome.goalId ?? null,
      scenarioId: input.scenarioId ?? outcome.scenarioId ?? null,
      weightsVersion: input.weightsVersion ?? null,
      evalSetVersion: input.evalSetVersion ?? null,
      expiryDate: input.expiryDate ?? null,
    };
    const seq = this.readEvents(userLogin).length + 1;
    this.appendEvent(userLogin, {
      seq,
      recommendationRef: input.recommendationRef,
      kind: "tracked",
      at: now.toISOString(),
      provenance,
    });
    return this.summaryFor(userLogin, input.recommendationRef);
  }

  recordTerminal(
    userLogin: string,
    recommendationRef: string,
    input: RecordOutcomeTerminalInput,
  ): { appended: boolean; reason?: string } {
    const summary = this.summaryFor(userLogin, recommendationRef);
    if (!summary) return { appended: false, reason: "recommendation is not tracked" };
    if (summary.status !== "open") {
      return {
        appended: false,
        reason: `already terminal (${summary.status}); the first terminal record stands`,
      };
    }
    const now = input.now ?? new Date();
    const seq = this.readEvents(userLogin).length + 1;
    this.appendEvent(userLogin, {
      seq,
      recommendationRef,
      kind: input.kind,
      at: now.toISOString(),
      pnlAfterCost: input.pnlAfterCost ?? null,
      notes: input.notes,
    });
    return { appended: true };
  }

  list(userLogin: string): OutcomeTrackingSummary[] {
    const events = this.readEvents(userLogin);
    const byRef = new Map<string, TrackingEvent[]>();
    for (const e of events) {
      const list = byRef.get(e.recommendationRef) ?? [];
      list.push(e);
      byRef.set(e.recommendationRef, list);
    }
    const out: OutcomeTrackingSummary[] = [];
    for (const list of byRef.values()) {
      const s = summarizeTrackingEvents(list);
      if (s) out.push(s);
    }
    return out.sort((a, b) => (a.trackedAt < b.trackedAt ? 1 : -1));
  }

  expireDue(
    userLogin: string,
    input: { now: Date; finalPnlByRef: Record<string, number> },
  ): { expired: string[]; awaitingPrice: string[] } {
    const expired: string[] = [];
    const awaitingPrice: string[] = [];
    const nowIso = input.now.toISOString();
    for (const summary of this.list(userLogin)) {
      if (summary.status !== "open") continue;
      const expiry = summary.provenance.expiryDate;
      if (!expiry || expiry > nowIso.slice(0, 10)) continue;
      const pnl = input.finalPnlByRef[summary.recommendationRef];
      if (typeof pnl !== "number") {
        awaitingPrice.push(summary.recommendationRef);
        continue;
      }
      const res = this.recordTerminal(userLogin, summary.recommendationRef, {
        kind: "expired",
        pnlAfterCost: pnl,
        now: input.now,
      });
      if (res.appended) expired.push(summary.recommendationRef);
    }
    return { expired, awaitingPrice };
  }

  buildPath(userLogin: string, track: TrackRecord): OutcomesPathEntry[] {
    const tracking = new Map(
      this.list(userLogin).map((s) => [s.recommendationRef, s])
    );
    return this.goals.listOutcomes(userLogin).map((outcome) => ({
      outcome,
      tracking: outcome.recommendationRef
        ? (tracking.get(outcome.recommendationRef) ?? null)
        : null,
      trackIdeas: outcome.screenRunRef
        ? track.ideas.filter((i) => i.runId === outcome.screenRunRef)
        : [],
    }));
  }
}
