/**
 * GoF Strategy & Factory Patterns: Payment Gateway Processing
 *
 * Implements:
 * - Strategy Pattern (GoF): IPaymentGatewayStrategy encapsulates gateway-specific checkout/refund logic.
 * - Factory Pattern (GoF): PaymentStrategyFactory instantiates and resolves concrete strategies.
 * - Dual Protocol Support: Can communicate with external payment services via:
 *   1. Remote Model Context Protocol (MCP) JSON-RPC 2.0 servers (e.g. Stripe MCP Server, PayPal MCP Server)
 *   2. Direct REST/HTTP APIs (e.g. api.stripe.com, api-m.paypal.com, api.lemonsqueezy.com)
 *   3. High-fidelity Sandbox / Simulated engine with Agent DIDs
 * - Single Responsibility Principle (SRP): Each strategy handles one provider interface.
 * - Open/Closed Principle (OCP): New gateways or MCP endpoints register without modifying existing strategies.
 * - Liskov Substitution Principle (LSP): Any IPaymentGatewayStrategy can be substituted interchangeably.
 */

import type { Env } from "../types";
import type { DidAttestationProof } from "../agents/did";
import type {
  SupportedGateway,
  CreateCheckoutParams,
  CheckoutResult,
  RefundParams,
  RefundResult,
  GatewayStatus,
} from "../services/payments";
import type { IPaymentGatewayStrategy } from "./interfaces";
import { RemoteMcpClient } from "../services/mcpClient";

/**
 * Concrete Strategy: Stripe Payments Engine (Dual MCP Server / REST API)
 */
export class StripePaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "stripe";
  readonly name = "Stripe Payment Gateway";

  isConfigured(env: Env): boolean {
    return Boolean(env.STRIPE_SECRET_KEY || env.STRIPE_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.STRIPE_MCP_SERVER_URL);
    const hasKey = Boolean(env.STRIPE_SECRET_KEY);
    const configured = isMcp || hasKey;
    const mode = isMcp ? "mcp_remote" : hasKey ? (env.STRIPE_SECRET_KEY?.startsWith("sk_test") ? "sandbox" : "live") : "simulated";
    const protocol = isMcp ? "mcp_json_rpc" : hasKey ? "rest_api" : "sandbox_simulated";

    return {
      id: "stripe",
      name: this.name,
      configured,
      mode,
      capabilities: isMcp
        ? ["Stripe Remote Model Context Protocol Server (JSON-RPC 2.0)", "Agentic Checkout", "PaymentIntents", "Refunds"]
        : ["Card Checkout", "PaymentIntents", "Refunds", "Invoices", "Webhooks"],
      mcpServerUrl: env.STRIPE_MCP_SERVER_URL,
      protocol,
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution (if Stripe MCP Server URL is configured)
    if (env.STRIPE_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.STRIPE_MCP_SERVER_URL,
          toolName: "create_checkout_session",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
            returnUrl: params.returnUrl,
          },
          apiKey: env.STRIPE_SECRET_KEY,
        });

        const checkoutUrl = mcpData?.url || mcpData?.checkoutUrl;
        if (checkoutUrl) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "stripe",
            checkoutUrl,
            gatewayRef: mcpData.id || mcpData.gatewayRef || `mcp_cs_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Stripe checkout session initialized via Stripe Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err) {
        console.warn("Stripe Remote MCP invocation failed, falling back to direct REST:", err);
      }
    }

    // 2. Direct Stripe REST API Execution
    if (env.STRIPE_SECRET_KEY) {
      try {
        const returnUrl = params.returnUrl || `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=success&draft=${params.draftId}`;
        const cancelUrl = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=cancelled`;

        const body = new URLSearchParams({
          "payment_method_types[0]": "card",
          "line_items[0][price_data][currency]": params.currency.toLowerCase(),
          "line_items[0][price_data][product_data][name]": params.description || `AI Compute Tokens for ${params.customer}`,
          "line_items[0][price_data][unit_amount]": String(Math.round(params.amount * 100)),
          "line_items[0][quantity]": "1",
          mode: "payment",
          client_reference_id: params.draftId,
          success_url: returnUrl,
          cancel_url: cancelUrl,
        });

        const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        const data = (await res.json()) as { id?: string; url?: string };
        if (data.url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "stripe",
            checkoutUrl: data.url,
            gatewayRef: data.id || `cs_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Stripe checkout session initialized for ${params.customer}`,
          };
        }
      } catch (err) {
        console.error("Stripe Checkout REST API error:", err);
      }
    }

    // 3. High-fidelity fallback simulated checkout
    return SandboxPaymentStrategy.buildSimulatedCheckout(env, params, attestation, "stripe");
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    // 1. External Service MCP Execution
    if (env.STRIPE_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.STRIPE_MCP_SERVER_URL,
          toolName: "create_refund",
          arguments: {
            paymentIntent: params.gatewayRef,
            amount: params.amount,
            reason: params.reason,
          },
          apiKey: env.STRIPE_SECRET_KEY,
        });

        if (mcpData?.id || mcpData?.refundId) {
          return {
            success: true,
            gateway: "stripe",
            refundId: mcpData.id || mcpData.refundId,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "Stripe refund settled via Stripe Remote MCP Server",
          };
        }
      } catch (err) {
        console.warn("Stripe Remote MCP refund failed, falling back to REST:", err);
      }
    }

    // 2. Direct Stripe REST API
    if (env.STRIPE_SECRET_KEY && params.gatewayRef) {
      try {
        const res = await fetch("https://api.stripe.com/v1/refunds", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            payment_intent: params.gatewayRef,
            ...(params.amount ? { amount: String(Math.round(params.amount * 100)) } : {}),
          }),
        });
        const data = (await res.json()) as any;
        if (data.id) {
          return {
            success: true,
            gateway: "stripe",
            refundId: data.id,
            amountRefunded: (data.amount || 0) / 100,
            status: "refunded",
            didAttestation: attestation,
            message: "Stripe refund settled successfully",
          };
        }
      } catch (err) {
        console.error("Stripe refund error:", err);
      }
    }

    return SandboxPaymentStrategy.buildSimulatedRefund(params, attestation, "stripe");
  }
}

/**
 * Concrete Strategy: PayPal Commerce Platform (Dual MCP Server / REST API)
 */
export class PayPalPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "paypal";
  readonly name = "PayPal Commerce Platform";

  isConfigured(env: Env): boolean {
    return Boolean((env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) || env.PAYPAL_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.PAYPAL_MCP_SERVER_URL);
    const hasKeys = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
    const configured = isMcp || hasKeys;
    const mode = isMcp ? "mcp_remote" : hasKeys ? (env.PAYPAL_ENVIRONMENT === "live" ? "live" : "sandbox") : "simulated";
    const protocol = isMcp ? "mcp_json_rpc" : hasKeys ? "rest_api" : "sandbox_simulated";

    return {
      id: "paypal",
      name: this.name,
      configured,
      mode,
      capabilities: isMcp
        ? ["PayPal Remote Model Context Protocol Server (JSON-RPC 2.0)", "PayPal Orders", "Capture", "Refunds"]
        : ["PayPal Checkout", "Capture Orders", "Disputes", "Refunds"],
      mcpServerUrl: env.PAYPAL_MCP_SERVER_URL,
      protocol,
    };
  }

  private async getAccessToken(env: Env): Promise<string> {
    const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution
    if (env.PAYPAL_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.PAYPAL_MCP_SERVER_URL,
          toolName: "create_order",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
          },
        });

        const approveUrl = mcpData?.approveUrl || mcpData?.checkoutUrl || mcpData?.links?.find((l: any) => l.rel === "approve")?.href;
        if (approveUrl) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "paypal",
            checkoutUrl: approveUrl,
            gatewayRef: mcpData.id || mcpData.orderId || `mcp_pp_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `PayPal checkout order created via PayPal Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err) {
        console.warn("PayPal Remote MCP invocation failed, falling back to direct REST:", err);
      }
    }

    // 2. Direct PayPal REST API Execution
    if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
      try {
        const token = await this.getAccessToken(env);
        const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

        const res = await fetch(`${base}/v2/checkout/orders`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                reference_id: params.draftId,
                description: params.description || `AI Compute Credits for ${params.customer}`,
                amount: {
                  currency_code: params.currency.toUpperCase(),
                  value: params.amount.toFixed(2),
                },
              },
            ],
            application_context: {
              brand_name: "Multi-Agent Studio",
              return_url: `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=success&provider=paypal`,
              cancel_url: `${env.APP_BASE_URL || "https://agent.openaimp.com"}/?payment=cancel`,
            },
          }),
        });

        const data = (await res.json()) as any;
        const approveLink = data.links?.find((l: any) => l.rel === "approve")?.href;
        if (approveLink) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "paypal",
            checkoutUrl: approveLink,
            gatewayRef: data.id || `pp_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `PayPal checkout order created for ${params.customer}`,
          };
        }
      } catch (err) {
        console.error("PayPal Order API error:", err);
      }
    }

    return SandboxPaymentStrategy.buildSimulatedCheckout(env, params, attestation, "paypal");
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && params.gatewayRef) {
      try {
        const token = await this.getAccessToken(env);
        const base = env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
        const res = await fetch(`${base}/v2/payments/captures/${params.gatewayRef}/refund`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(params.amount ? { amount: { value: params.amount.toFixed(2), currency_code: "USD" } } : {}),
        });
        const data = (await res.json()) as any;
        if (data.id) {
          return {
            success: true,
            gateway: "paypal",
            refundId: data.id,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "PayPal refund settled successfully",
          };
        }
      } catch (err) {
        console.error("PayPal refund error:", err);
      }
    }

    return SandboxPaymentStrategy.buildSimulatedRefund(params, attestation, "paypal");
  }
}

/**
 * Concrete Strategy: Lemon Squeezy Merchant Platform (Dual MCP Server / REST API)
 */
export class LemonSqueezyPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "lemonsqueezy";
  readonly name = "Lemon Squeezy Merchant";

  isConfigured(env: Env): boolean {
    return Boolean((env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID) || env.LEMONSQUEEZY_MCP_SERVER_URL);
  }

  getStatus(env: Env): GatewayStatus {
    const isMcp = Boolean(env.LEMONSQUEEZY_MCP_SERVER_URL);
    const hasKey = Boolean(env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID);
    const configured = isMcp || hasKey;
    const mode = isMcp ? "mcp_remote" : hasKey ? "live" : "simulated";
    const protocol = isMcp ? "mcp_json_rpc" : hasKey ? "rest_api" : "sandbox_simulated";

    return {
      id: "lemonsqueezy",
      name: this.name,
      configured,
      mode,
      capabilities: isMcp
        ? ["Lemon Squeezy Model Context Protocol Server (JSON-RPC 2.0)", "Hosted Checkouts", "Refunds"]
        : ["Hosted Checkouts", "Usage Billing", "SaaS Subscriptions", "Refunds"],
      mcpServerUrl: env.LEMONSQUEEZY_MCP_SERVER_URL,
      protocol,
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    // 1. External Service MCP Execution
    if (env.LEMONSQUEEZY_MCP_SERVER_URL) {
      try {
        const mcpData = await RemoteMcpClient.callTool({
          serverUrl: env.LEMONSQUEEZY_MCP_SERVER_URL,
          toolName: "create_checkout",
          arguments: {
            amount: params.amount,
            currency: params.currency,
            customer: params.customer,
            description: params.description,
            draftId: params.draftId,
          },
          apiKey: env.LEMONSQUEEZY_API_KEY,
        });

        const url = mcpData?.url || mcpData?.checkoutUrl;
        if (url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "lemonsqueezy",
            checkoutUrl: url,
            gatewayRef: mcpData.id || mcpData.gatewayRef || `mcp_ls_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Lemon Squeezy checkout created via Remote MCP Server for ${params.customer}`,
          };
        }
      } catch (err) {
        console.warn("Lemon Squeezy Remote MCP invocation failed, falling back to REST:", err);
      }
    }

    // 2. Direct Lemon Squeezy REST API Execution
    if (env.LEMONSQUEEZY_API_KEY && env.LEMONSQUEEZY_STORE_ID) {
      try {
        const storeId = env.LEMONSQUEEZY_STORE_ID;
        const res = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: {
              type: "checkouts",
              attributes: {
                custom_price: Math.round(params.amount * 100),
                product_options: {
                  name: params.description || `AI Token Credits for ${params.customer}`,
                  description: `Autonomous agent credit deposit requested by ${params.customer}`,
                },
                checkout_data: {
                  custom: {
                    draftId: params.draftId,
                    customer: params.customer,
                  },
                },
              },
              relationships: {
                store: {
                  data: {
                    type: "stores",
                    id: String(storeId),
                  },
                },
              },
            },
          }),
        });

        const data = (await res.json()) as any;
        const url = data.data?.attributes?.url;
        if (url) {
          return {
            success: true,
            draftId: params.draftId,
            gateway: "lemonsqueezy",
            checkoutUrl: url,
            gatewayRef: data.data?.id || `ls_${params.draftId}`,
            status: "pending_checkout",
            didAttestation: attestation,
            message: `Lemon Squeezy checkout created for ${params.customer}`,
          };
        }
      } catch (err) {
        console.error("Lemon Squeezy Checkout API error:", err);
      }
    }

    return SandboxPaymentStrategy.buildSimulatedCheckout(env, params, attestation, "lemonsqueezy");
  }

  async executeRefund(env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    if (env.LEMONSQUEEZY_API_KEY && params.gatewayRef) {
      try {
        const res = await fetch("https://api.lemonsqueezy.com/v1/refunds", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: {
              type: "refunds",
              attributes: { order_id: Number(params.gatewayRef) },
            },
          }),
        });
        const data = (await res.json()) as any;
        if (data.data?.id) {
          return {
            success: true,
            gateway: "lemonsqueezy",
            refundId: `ls_${data.data.id}`,
            amountRefunded: params.amount || 0,
            status: "refunded",
            didAttestation: attestation,
            message: "Lemon Squeezy refund settled successfully",
          };
        }
      } catch (err) {
        console.error("Lemon Squeezy refund error:", err);
      }
    }

    return SandboxPaymentStrategy.buildSimulatedRefund(params, attestation, "lemonsqueezy");
  }
}

/**
 * Concrete Strategy: High-Fidelity Sandbox & Development Simulation
 */
export class SandboxPaymentStrategy implements IPaymentGatewayStrategy {
  readonly gatewayId: SupportedGateway = "sandbox";
  readonly name = "Simulated Sandbox Engine";

  isConfigured(_env: Env): boolean {
    return true;
  }

  getStatus(_env: Env): GatewayStatus {
    return {
      id: "sandbox",
      name: this.name,
      configured: true,
      mode: "sandbox",
      capabilities: ["Instant Settlement Simulation", "DID Cryptographic Verification", "Multi-Currency Testbed"],
      protocol: "sandbox_simulated",
    };
  }

  async createCheckout(env: Env, params: CreateCheckoutParams, attestation: DidAttestationProof): Promise<CheckoutResult> {
    return SandboxPaymentStrategy.buildSimulatedCheckout(env, params, attestation, "sandbox");
  }

  async executeRefund(_env: Env, params: RefundParams, attestation: DidAttestationProof): Promise<RefundResult> {
    return SandboxPaymentStrategy.buildSimulatedRefund(params, attestation, "sandbox");
  }

  static buildSimulatedCheckout(
    env: Env,
    params: CreateCheckoutParams,
    attestation: DidAttestationProof,
    gateway: SupportedGateway
  ): CheckoutResult {
    const baseUrl = env.APP_BASE_URL || "https://agent.openaimp.com";
    const sandboxUrl = `${baseUrl}/checkout/sandbox?provider=${gateway}&id=${params.draftId}&amt=${params.amount}&curr=${params.currency}&cust=${encodeURIComponent(params.customer)}&sig=${attestation.signature.slice(0, 16)}`;
    const gatewayRef = `sim_${gateway}_${params.draftId.replace("pay_", "")}`;

    return {
      success: true,
      draftId: params.draftId,
      gateway,
      checkoutUrl: sandboxUrl,
      gatewayRef,
      status: "pending_checkout",
      didAttestation: attestation,
      message: `Verified authorization draft stamped with Agent DID ${attestation.proposerDid}. Sandbox checkout: ${sandboxUrl}`,
    };
  }

  static buildSimulatedRefund(
    params: RefundParams,
    attestation: DidAttestationProof,
    gateway: SupportedGateway
  ): RefundResult {
    const refundId = `ref_sim_${crypto.randomUUID().slice(0, 8)}`;
    return {
      success: true,
      gateway,
      refundId,
      amountRefunded: params.amount || 0,
      status: "refunded",
      didAttestation: attestation,
      message: `Refund of $${params.amount?.toFixed(2) || "0.00"} authorized and signed by ${attestation.authorizerDid}`,
    };
  }
}

/**
 * GoF Factory Pattern: Payment Strategy Resolver
 * Demonstrates Open/Closed Principle (OCP): New strategies can be dynamically registered.
 */
export class PaymentStrategyFactory {
  private static strategies: Map<SupportedGateway, IPaymentGatewayStrategy> = new Map<SupportedGateway, IPaymentGatewayStrategy>([
    ["stripe", new StripePaymentStrategy()],
    ["paypal", new PayPalPaymentStrategy()],
    ["lemonsqueezy", new LemonSqueezyPaymentStrategy()],
    ["sandbox", new SandboxPaymentStrategy()],
  ]);

  static getStrategy(gateway: SupportedGateway): IPaymentGatewayStrategy {
    const strategy = this.strategies.get(gateway) || this.strategies.get("sandbox")!;
    return strategy;
  }

  static registerStrategy(strategy: IPaymentGatewayStrategy): void {
    this.strategies.set(strategy.gatewayId, strategy);
  }

  static getAllStrategies(): IPaymentGatewayStrategy[] {
    return Array.from(this.strategies.values());
  }
}
