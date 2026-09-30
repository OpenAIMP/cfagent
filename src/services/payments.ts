/**
 * Multi-Gateway Payment Execution Engine
 * Integrates Stripe, PayPal, and Lemon Squeezy with verifiable Agent DIDs.
 *
 * Implements SOLID Principles & GoF Strategy Pattern:
 * - Strategy Pattern (GoF): IPaymentGatewayStrategy encapsulates processor logic.
 * - Factory Pattern (GoF): PaymentStrategyFactory resolves concrete strategies.
 * - Single Responsibility Principle (SRP): Payment orchestration is decoupled from gateway API specifics.
 * - Open/Closed Principle (OCP): New gateways register without altering PaymentGatewayService.
 */

import type { Env } from "../types";
import { AGENT_DIDS, createDidAttestation, type DidAttestationProof } from "../agents/did";
import { PaymentStrategyFactory } from "../patterns/paymentStrategies";

export type SupportedGateway = "stripe" | "paypal" | "lemonsqueezy" | "sandbox";

export interface CreateCheckoutParams {
  draftId: string;
  amount: number;
  currency: string;
  customer: string;
  description?: string;
  gateway?: SupportedGateway;
  returnUrl?: string;
  userLogin: string;
}

export interface CheckoutResult {
  success: boolean;
  draftId?: string;
  gateway: SupportedGateway;
  checkoutUrl: string;
  gatewayRef: string;
  status: "pending_checkout" | "authorized" | "completed";
  didAttestation: DidAttestationProof;
  message: string;
}

export interface RefundParams {
  transactionId: string;
  amount?: number;
  gatewayRef?: string;
  gateway: SupportedGateway;
  reason?: string;
  userLogin: string;
}

export interface RefundResult {
  success: boolean;
  gateway: SupportedGateway;
  refundId: string;
  amountRefunded: number;
  status: "refunded" | "processing";
  didAttestation: DidAttestationProof;
  message: string;
}

export interface GatewayStatus {
  id: SupportedGateway;
  name: string;
  configured: boolean;
  mode: "live" | "sandbox" | "simulated" | "mcp_remote";
  capabilities: string[];
  mcpServerUrl?: string;
  protocol: "mcp_json_rpc" | "rest_api" | "sandbox_simulated";
}

export class PaymentGatewayService {
  constructor(private env: Env) {}

  /**
   * Returns active status and configuration state for payment gateways
   */
  getGatewayStatuses(): GatewayStatus[] {
    const strategies = PaymentStrategyFactory.getAllStrategies();
    // Return the 3 primary supported gateways + sandbox
    return strategies
      .filter((s) => ["stripe", "paypal", "lemonsqueezy"].includes(s.gatewayId))
      .map((s) => s.getStatus(this.env));
  }

  /**
   * Creates a checkout session or order across Stripe, PayPal, Lemon Squeezy, or Sandbox
   */
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    const gateway = (params.gateway || "stripe").toLowerCase() as SupportedGateway;
    const authorizerDid = `did:user:github:${params.userLogin}`;

    // 1. Generate Verifiable Agent DID Attestation
    const didAttestation = await createDidAttestation({
      draftId: params.draftId,
      action: "charge",
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid,
    });

    // 2. Resolve Strategy via Factory (GoF Strategy + Factory Pattern)
    const strategy = PaymentStrategyFactory.getStrategy(gateway);
    return strategy.createCheckout(this.env, params, didAttestation);
  }

  /**
   * Executes a refund or returns signed attestation proof across supported gateways
   */
  async executeRefund(params: RefundParams): Promise<RefundResult> {
    const authorizerDid = `did:user:github:${params.userLogin}`;

    // 1. Generate Verifiable Agent DID Attestation
    const didAttestation = await createDidAttestation({
      draftId: params.transactionId,
      action: "refund",
      amount: params.amount || 0,
      currency: "USD",
      customer: "settled_account",
      gateway: params.gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid,
    });

    // 2. Resolve Strategy via Factory (GoF Strategy + Factory Pattern)
    const strategy = PaymentStrategyFactory.getStrategy(params.gateway);
    return strategy.executeRefund(this.env, params, didAttestation);
  }
}
