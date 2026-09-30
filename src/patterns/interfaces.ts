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
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { SupportedGateway, CreateCheckoutParams, CheckoutResult, RefundParams, RefundResult, GatewayStatus } from "../services/payments";
import type { DidAttestationProof } from "../agents/did";

/**
 * Context provided to every tool command during execution
 */
export interface McpToolContext {
  env: Env;
  orm: DatabaseORM;
  sessionId: string;
  requestId?: string;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  facade?: IMcpSystemFacade;
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
