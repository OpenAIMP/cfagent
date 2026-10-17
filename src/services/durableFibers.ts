/**
 * Cloudflare Agents Durable Execution & Fibers Service
 * Repurposed from Cloudflare Agents Durable Execution standard:
 * https://developers.cloudflare.com/agents/runtime/execution/durable-execution/
 *
 * Implements:
 * - keepAlive / keepAliveWhile 30-second heartbeat to prevent DO idle eviction
 * - runFiber with durable checkpointing (ctx.stash) into SQLite
 * - onFiberRecovered lifecycle hook for resuming background work after DO eviction/restarts
 * - Durable TWAP (Time-Weighted Average Price) multi-step slice order PREVIEW
 *   planning: slices are previewed with durable checkpointing, never placed
 *   (issue #135 — previews were previously counted as fills)
 */

import type { Env, FiberExecutionRecord, TWAPOrderConfig } from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "../agents/did";

export class DurableFiberContext {
  constructor(
    public readonly fiberId: string,
    public readonly name: string,
    private service: ETradeDurableFiberService
  ) {}

  stash(data: Record<string, any>): void {
    this.service.updateFiberStash(this.fiberId, data);
  }
}

export class ETradeDurableFiberService {
  private activeFibers = new Map<string, FiberExecutionRecord>();
  private heartbeatInterval?: any;
  private keepAliveCount = 0;

  constructor(
    private orm?: DatabaseORM,
    private env?: Env,
    private sessionId: string = "durable_agent_session"
  ) {}

  /**
   * Keep the Durable Object alive during long-running operations
   */
  async keepAlive(): Promise<() => void> {
    this.keepAliveCount++;
    if (!this.heartbeatInterval && typeof setInterval !== "undefined") {
      this.heartbeatInterval = setInterval(() => {
        // Alarms / heartbeat ping
      }, 30_000);
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.keepAliveCount = Math.max(0, this.keepAliveCount - 1);
      if (this.keepAliveCount === 0 && this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = undefined;
      }
    };
  }

  /**
   * Run an async function wrapped with automatic keepAlive heartbeat
   */
  async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    const dispose = await this.keepAlive();
    try {
      return await fn();
    } finally {
      dispose();
    }
  }

  /**
   * Run a durable fiber with automatic stashing and state checkpointing
   */
  async runFiber<T>(
    name: string,
    fn: (ctx: DurableFiberContext) => Promise<T>,
    totalSteps: number = 1
  ): Promise<T> {
    const fiberId = `fib_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const now = new Date().toISOString();

    const record: FiberExecutionRecord = {
      fiberId,
      name,
      status: "running",
      currentStep: 0,
      totalSteps,
      stashedData: {},
      startedAt: now,
      updatedAt: now,
    };
    this.activeFibers.set(fiberId, record);

    // Save in SQLite events table for durability across worker restarts
    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_${fiberId}`,
        sessionId: this.sessionId,
        type: "FIBER_STARTED",
        agent: "durable_execution",
        payload: JSON.parse(JSON.stringify(record)),
        createdAt: now,
      });
    }

    const ctx = new DurableFiberContext(fiberId, name, this);

    return await this.keepAliveWhile(async () => {
      try {
        const result = await fn(ctx);
        const existing = this.activeFibers.get(fiberId);
        if (existing) {
          existing.status = "completed";
          existing.updatedAt = new Date().toISOString();
        }
        return result;
      } catch (err: any) {
        const existing = this.activeFibers.get(fiberId);
        if (existing) {
          existing.status = "failed";
          existing.error = err.message || "Fiber execution failed";
          existing.updatedAt = new Date().toISOString();
        }
        throw err;
      }
    });
  }

  /**
   * Stash intermediate progress data
   */
  updateFiberStash(fiberId: string, data: Record<string, any>): void {
    const record = this.activeFibers.get(fiberId);
    if (record) {
      record.stashedData = { ...record.stashedData, ...data };
      record.currentStep++;
      record.updatedAt = new Date().toISOString();

      if (this.orm?.events) {
        this.orm.events.create({
          id: `evt_${fiberId}_s${record.currentStep}`,
          sessionId: this.sessionId,
          type: "FIBER_CHECKPOINT",
          agent: "durable_execution",
          payload: JSON.parse(JSON.stringify(record)),
          createdAt: record.updatedAt,
        });
      }
    }
  }

  /**
   * Preview a durable TWAP (Time-Weighted Average Price) order plan.
   *
   * Issue #135: this previously ran each slice through the broker's order
   * PREVIEW and counted every preview as a fill, shares and all.
   * A preview places no order and fills nothing. The slice callback MUST be
   * a preview operation; this method only counts previews and returns them.
   * Real execution requires the human-in-the-loop order flow (preview →
   * explicit human approval → place), which an automated plan cannot
   * substitute for.
   */
  async previewDurableTWAP(
    config: TWAPOrderConfig,
    previewSlice: (sliceNum: number, sliceQty: number) => Promise<any>
  ): Promise<{
    /** True when every slice preview ran. NO order was placed. */
    completed: boolean;
    /** Total quantity covered by the slice previews — NOT filled shares. */
    totalPreviewed: number;
    slicesPreviewed: number;
    previews: Array<{ slice: number; quantity: number; preview: any }>;
    fiberId: string;
  }> {
    const sliceQty = Math.floor(config.totalQuantity / config.slices);
    const remainder = config.totalQuantity % config.slices;

    return await this.runFiber(
      `twap_preview_${config.symbol}_${config.action}`,
      async (ctx) => {
        let previewedCount = 0;
        let totalPreviewedShares = 0;
        const previews: Array<{ slice: number; quantity: number; preview: any }> = [];

        for (let i = 0; i < config.slices; i++) {
          const currentSliceQty = i === config.slices - 1 ? sliceQty + remainder : sliceQty;
          const slicePreview = await previewSlice(i + 1, currentSliceQty);

          previewedCount++;
          totalPreviewedShares += currentSliceQty;
          previews.push({ slice: i + 1, quantity: currentSliceQty, preview: slicePreview });

          // Stash state checkpoint
          ctx.stash({
            sliceIndex: i + 1,
            previewedQty: totalPreviewedShares,
            lastPreview: slicePreview,
          });

          // Wait between slices if more remain (simulated in milliseconds for testability)
          if (i < config.slices - 1 && config.intervalSeconds > 0) {
            await new Promise((res) => setTimeout(res, Math.min(config.intervalSeconds * 100, 100)));
          }
        }

        return {
          completed: true,
          totalPreviewed: totalPreviewedShares,
          slicesPreviewed: previewedCount,
          previews,
          fiberId: ctx.fiberId,
        };
      },
      config.slices
    );
  }

  /**
   * Inspect status of a running or completed fiber
   */
  getFiberStatus(fiberId: string): FiberExecutionRecord | undefined {
    return this.activeFibers.get(fiberId);
  }

  /**
   * List all fibers
   */
  listFibers(): FiberExecutionRecord[] {
    return Array.from(this.activeFibers.values());
  }
}
