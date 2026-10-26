/**
 * SOLID, GoF, and GRASP Architectural Contracts
 *
 * Principles Applied:
 * - ISP (Interface Segregation Principle): Focused, cohesive contracts instead of monolithic types.
 * - DIP (Dependency Inversion Principle): High-level agents & MCP router depend on these abstractions.
 * - GoF Command Pattern: IMcpToolCommand encapsulates tool execution.
 * - GoF Strategy Pattern: IPaymentGatewayStrategy for multi-processor execution.
 * - GoF Observer Pattern: IAuditPublisher & IAuditObserver for decoupled event streaming.
 * - GoF Facade & GRASP Controller: IMcpSystemFacade coordinates platform subsystems.
 */

import type { z } from "zod";
import type { AsyncJobSubmission, Env, FossQuote, FossCompanyFundamentals, FossHistoricalBar, AlpacaMarketSnapshot } from "../types";
import type { DatabaseORM } from "../orm";
import type { AdsRevenueScopedModes } from "../config/adsRevenueModes";
import type { SupportedGateway, CreateCheckoutParams, CheckoutResult, RefundParams, RefundResult, GatewayStatus } from "../services/payments";
import type { DidAttestationProof } from "../agents/did";

/**
 * Context provided to every tool command during execution
 */
export interface McpToolContext {
  env: Env;
  orm: DatabaseORM;
  sessionId: string;
  /**
   * #1686: optional DO blob handle for full capture, populated by the
   * execution-context owner (chat turns); unset → today's outcome-only
   * contract. Tools that ignore it are unaffected.
   */
  storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"];
  /**
   * #1721: optional session/user carriers for the categories /
   * referrals / external-ads switches (run comes from the per-call
   * `mode` input, global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env.
   */
  scopedModes?: AdsRevenueScopedModes;
  /**
   * #1722: optional session/user carriers for the NLQ_MODE switch
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/nlqModes.ts.
   */
  scopedNlqModes?: import("../config/nlqModes").NlqScopedModes;
  /**
   * #1723: optional session/user carriers for the KNOWLEDGE_MODE switch
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/knowledgeMemoryModes.ts.
   */
  scopedKnowledgeModes?: import("../config/knowledgeMemoryModes").KnowledgeScopedModes;
  /**
   * #1723: optional session/user carriers for the MEMORY_READ_MODE
   * switch (run comes from the per-call `mode` input / REST `?mode=`,
   * global env from `env`). Populated by the execution-context
   * owner; unset carriers fall through to env. Covers the read cap
   * only — never remember/delete/clear.
   */
  scopedMemoryModes?: import("../config/knowledgeMemoryModes").MemoryScopedModes;
  /**
   * #1724: optional session/user carriers for the HTTP_DELIVERY_MODE
   * switch (run comes from the per-request `x-delivery-mode` header
   * on the /mcp POST, global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env.
   * See src/config/asyncJobModes.ts. Governs tools/call wrapping
   * only — get_async_job / list_async_jobs are never wrapped.
   */
  scopedHttpDeliveryModes?: import("../config/asyncJobModes").HttpDeliveryScopedModes;
  /**
   * #1724: optional session/user carriers for the JOB_LIST_ENVELOPE
   * switch (run comes from the per-call `envelope` input, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. Covers the list envelope only —
   * never the single-job full record. See src/config/asyncJobModes.ts.
   */
  scopedJobListModes?: import("../config/asyncJobModes").JobListScopedModes;
  /**
   * #1726: optional session/user carriers for the E*TRADE switches
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/etradeModes.ts. The execute
   * gate is never carried here — it is not configurable.
   */
  scopedEtradeModes?: import("../config/etradeModes").EtradeScopedModes;
  /**
   * #1727: optional session/user carriers for the FOSS switches
   * (run comes from the per-call `mode` input, global env from
   * `env`). Populated by the execution-context owner; unset carriers
   * fall through to env. See src/config/fossModes.ts.
   */
  scopedFossModes?: import("../config/fossModes").FossScopedModes;
  requestId?: string;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  facade?: IMcpSystemFacade;
  submitJob?: (job: AsyncJobSubmission) => Promise<{
    jobId: string;
    status: "queued";
    statusUrl: string;
  }>;
  getJob?: (jobId: string) => unknown;
  listJobs?: () => unknown[];
}

/**
 * GoF Command Pattern: Encapsulates a platform capability as an executable tool.
 * Satisfies SRP (single responsibility per command) and LSP (substitutable execution).
 */
export interface IMcpToolCommand<TInput = any, TOutput = any> {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  readonly zodSchema: z.ZodType<TInput>;

  execute(input: TInput, context: McpToolContext): Promise<TOutput>;
}

/**
 * GoF Strategy Pattern: Encapsulates payment provider processing algorithms.
 * Allows runtime switching between Stripe, PayPal, Lemon Squeezy, and Sandbox.
 */
export interface IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway;
  readonly name: string;
  
  isConfigured(env: Env): boolean;
  getStatus(env: Env): GatewayStatus;
  createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult>;
  executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult>;
}

/**
 * Audit Event Payload
 */
export interface AuditEvent {
  id: string;
  sessionId: string;
  type: string;
  agent: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

/**
 * GoF Observer Pattern: Observer contract for audit/observability listeners.
 */
export interface IAuditObserver {
  onAuditEvent(event: AuditEvent): Promise<void> | void;
}

/**
 * GoF Observer Pattern: Subject contract for publishing system events.
 */
export interface IAuditPublisher {
  subscribe(observer: IAuditObserver): () => void;
  publish(type: string, agent: any, payload: Record<string, unknown>): void;
}

/**
 * GoF Facade & GRASP Controller Pattern:
 * Unified high-level interface encapsulating ORM, Payments, NLQ, Memory, and DIDs.
 */
export interface IMcpSystemFacade {
  readonly orm: DatabaseORM;
  readonly env: Env;
  readonly sessionId: string;
  readonly auditPublisher: IAuditPublisher;

  // Subsystem Operations
  executeNlq(query: string): Promise<any>;
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  executeRefund(params: RefundParams): Promise<RefundResult>;
  getGatewayStatuses(): GatewayStatus[];
  createAttestation(params: {
    draftId: string;
    action: string;
    amount: number;
    currency: string;
    customer: string;
    gateway: SupportedGateway;
    proposerDid?: string;
  }): Promise<DidAttestationProof>;
  publishAudit(type: string, agent: any, payload: Record<string, unknown>): void;
}

/**
 * GoF Strategy Pattern: Market Data Provider Strategy contract for FOSS research & quoting
 * Implemented by YahooFinanceProvider, AlpacaMarketDataProvider, and HybridFossProvider.
 */
export interface IFossMarketDataProvider {
  readonly providerId: "yfinance" | "alpaca" | "hybrid";
  readonly name: string;
  isConfigured(env?: Env): boolean;
  getQuote(symbol: string): Promise<FossQuote>;
  getFundamentals(symbol: string): Promise<FossCompanyFundamentals>;
  getHistoricalBars(symbol: string, timeframe?: string, limit?: number): Promise<FossHistoricalBar[]>;
  getMarketSnapshot?(symbol: string): Promise<AlpacaMarketSnapshot>;
}
