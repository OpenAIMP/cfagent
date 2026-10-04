/**
 * Cloudflare Agentic Payments Service (x402 & Machine Payments Protocol - MPP)
 * Based on Cloudflare Agents SDK Payments Documentation:
 * https://developers.cloudflare.com/agents/tools/payments/
 *
 * Implements:
 * 1. HTTP 402 Payment Required negotiation for monetized AI agent resources
 * 2. x402 Protocol specification (Coinbase & Cloudflare Foundation):
 *    - PAYMENT-REQUIRED challenge header
 *    - PAYMENT-SIGNATURE client proof header
 *    - PAYMENT-RESPONSE server receipt header
 * 3. Machine Payments Protocol (MPP / mppx) specification:
 *    - WWW-Authenticate: Payment challenge header
 *    - Authorization: Payment credential header
 *    - Payment-Receipt confirmation header
 * 4. Dual role:
 *    - Provider: Monetizes Options Screener ($0.05), Equity Research ($0.10), and Quantitative Signals ($0.02)
 *    - Consumer: Outbound agent spending on external feeds with strict Human-in-the-Loop (HITL) safety limit
 * 5. Full financial ledger persistence in SQLite (mas_transactions & mas_events) with Agent DID cryptographic attestation
 */

import type {
  Env,
  X402PaymentChallenge,
  X402PaymentProof,
  MppChallenge,
  MppPaymentProof,
  AgenticPaymentReceipt,
  AgenticWalletStatus,
  PaidTradingServiceTier,
  PaymentRequiredCallback,
  TransactionRecord,
} from "../types";
import { Mppx, tempo } from "mppx/server";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "../agents/did";
import { verifyOnChainClaim, type X402ClaimVerifier } from "./x402Verifier";

// Fallback replay guard used only when no KV namespace is bound.
const consumedTxHashes = new Set<string>();

/**
 * Catalogue of Paid Trading Services offered by E*TRADE Trading Agent
 */
export const TRADING_PAID_SERVICES: Record<string, PaidTradingServiceTier> = {
  OPTIONS_SCREENER: {
    id: "options_screener",
    resource: "/api/premium/options-scan",
    name: "E*TRADE Institutional Options & Greeks Screener",
    description: "Deep options screening with Delta, Gamma, Theta, IV percentile, and volume/OI flow analysis.",
    priceUSD: 0.05,
    rateLimitPerMin: 60,
  },
  MARKET_RESEARCH: {
    id: "market_research",
    resource: "/api/premium/market-research",
    name: "E*TRADE Autonomous Equity Research Report",
    description: "Multi-ticker valuation metrics, fundamentals, and algorithmic trade signals with DID proof.",
    priceUSD: 0.10,
    rateLimitPerMin: 30,
  },
  STOCK_SIGNALS: {
    id: "stock_signals",
    resource: "/api/premium/stock-signals",
    name: "Real-Time Quant Anomaly Signals",
    description: "Live capital flow anomaly detection, unusual volume, and momentum breakouts.",
    priceUSD: 0.02,
    rateLimitPerMin: 120,
  },
};

export class ETradeAgenticPaymentService {
  private network: string;
  private recipient: string;
  private facilitatorUrl: string;
  private autoApproveLimitUSD: number;
  private agentWalletAddress: string;
  private mppSecretKey?: string;

  constructor(
    private orm?: DatabaseORM,
    private env?: Env,
    private sessionId: string = "default_trader",
    private claimVerifier: X402ClaimVerifier = verifyOnChainClaim
  ) {
    this.network = this.env?.X402_NETWORK || "base-sepolia";
    this.recipient =
      this.env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550";
    this.facilitatorUrl = this.env?.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    this.autoApproveLimitUSD = Number(this.env?.X402_AUTO_APPROVE_LIMIT || 0.05);
    this.agentWalletAddress =
      this.env?.X402_AGENT_WALLET_KEY || "0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B";
    this.mppSecretKey = this.env?.MPP_SECRET_KEY;
  }

  // =========================================================================
  // 1. Server-Side Provider: HTTP 402 Challenge Generation & Verification
  // =========================================================================

  /**
   * Extract nonce from x402 PAYMENT-SIGNATURE proof
   */
  extractNonce(sigOrHeaders?: string | null | Headers | Record<string, string>): string | undefined {
    if (!sigOrHeaders) return undefined;
    let rawStr = "";
    if (typeof sigOrHeaders === "string") {
      rawStr = sigOrHeaders;
    } else if (sigOrHeaders instanceof Headers) {
      rawStr = sigOrHeaders.get("PAYMENT-SIGNATURE") || sigOrHeaders.get("payment-signature") || "";
    } else if (typeof sigOrHeaders === "object") {
      rawStr = (sigOrHeaders as any)["PAYMENT-SIGNATURE"] || (sigOrHeaders as any)["payment-signature"] || "";
    }

    if (!rawStr) return undefined;

    try {
      let parsed: any;
      try {
        parsed = JSON.parse(Buffer.from(rawStr, "base64").toString("utf-8"));
      } catch {
        parsed = JSON.parse(rawStr);
      }
      return parsed.nonce ? String(parsed.nonce) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Create an x402-compliant payment challenge
   */
  createX402Challenge(
    resource: string,
    priceUSD: number = 0.05,
    description: string = "E*TRADE Trading Intelligence Access",
    nonce?: string
  ): X402PaymentChallenge {
    const finalNonce = nonce || `n_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes TTL

    return {
      version: "1.0",
      network: this.network,
      recipient: this.recipient,
      amount: priceUSD,
      currency: "USDC",
      facilitator: this.facilitatorUrl,
      description,
      resource,
      nonce: finalNonce,
      expiresAt,
    };
  }

  /**
   * Create an MPP-compliant payment challenge
   */
  createMppChallenge(
    resource: string,
    priceUSD: number = 0.05,
    description: string = "E*TRADE Trading Intelligence Access"
  ): MppChallenge {
    return {
      protocol: "mpp",
      method: "tempo",
      amount: priceUSD.toFixed(2),
      currency: "0x20c0000000000000000000000000000000000000", // Standard USDC Contract Identifier
      recipient: this.recipient,
      description,
      realm: resource,
      testnet: this.network.includes("sepolia") || this.network.includes("test"),
    };
  }

  /**
   * Encode x402 challenge into standard PAYMENT-REQUIRED HTTP header
   */
  formatX402ChallengeHeader(challenge: X402PaymentChallenge): string {
    return Buffer.from(JSON.stringify(challenge)).toString("base64");
  }

  /**
   * Encode MPP challenge into standard WWW-Authenticate HTTP header
   */
  formatMppChallengeHeader(challenge: MppChallenge): string {
    return `Payment method="${challenge.method}", amount="${challenge.amount}", currency="${challenge.currency}", recipient="${challenge.recipient}", description="${encodeURIComponent(challenge.description)}"`;
  }

  /**
   * Generate an HTTP 402 Payment Required response carrying x402 and MPP challenges
   */
  createPaymentRequiredResponse(
    challenge: X402PaymentChallenge,
    mppChallenge?: MppChallenge,
    reason?: string
  ): Response {
    const mpp = mppChallenge || this.createMppChallenge(challenge.resource, challenge.amount, challenge.description);
    const x402HeaderVal = this.formatX402ChallengeHeader(challenge);
    const mppHeaderVal = this.formatMppChallengeHeader(mpp);

    // Record challenge audit event
    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_402_${Date.now()}`,
        sessionId: this.sessionId,
        type: "AGENTIC_PAYMENT_CHALLENGE",
        agent: "trading",
        payload: {
          resource: challenge.resource,
          amount: challenge.amount,
          currency: challenge.currency,
          recipient: challenge.recipient,
          network: challenge.network,
          nonce: challenge.nonce,
        },
        createdAt: new Date().toISOString(),
      });
    }

    const body = {
      error: "Payment Required",
      statusCode: 402,
      message: `Access to ${challenge.resource} requires an agentic payment of $${challenge.amount.toFixed(2)} ${challenge.currency}.`,
      protocols: {
        x402: {
          header: "PAYMENT-SIGNATURE",
          challenge,
        },
        mpp: {
          header: "Authorization: Payment",
          challenge: mpp,
        },
      },
      ...(reason ? { reason } : {}),
      facilitator: challenge.facilitator,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 402,
      statusText: "Payment Required",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": x402HeaderVal,
        ...(reason ? { "X-Payment-Error": reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) } : {}),
        "WWW-Authenticate": mppHeaderVal,
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt, X-Payment-Error",
      },
    });
  }

  private async consumeTxHash(txHash: string): Promise<boolean> {
    const key = `x402tx:${txHash.toLowerCase()}`;
    const kv = this.env?.SESSIONS;
    if (kv) {
      if (await kv.get(key)) return false;
      await kv.put(key, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 365 });
      return true;
    }
    if (consumedTxHashes.has(key)) return false;
    consumedTxHashes.add(key);
    return true;
  }

  private async releaseTxHash(txHash: string): Promise<void> {
    const key = `x402tx:${txHash.toLowerCase()}`;
    if (this.env?.SESSIONS) await this.env.SESSIONS.delete(key);
    else consumedTxHashes.delete(key);
  }

  /**
   * Verify an incoming x402 or MPP payment signature
   */
  async verifyPayment(
    headers: Headers | Record<string, string>,
    challenge: X402PaymentChallenge | MppChallenge
  ): Promise<{ valid: boolean; receipt?: AgenticPaymentReceipt; reason?: string }> {
    const getHeader = (name: string): string | null => {
      if (headers instanceof Headers) return headers.get(name);
      return headers[name] || headers[name.toLowerCase()] || null;
    };

    const x402Sig = getHeader("PAYMENT-SIGNATURE") || getHeader("payment-signature");
    const mppAuth = getHeader("Authorization") || getHeader("authorization");

    // 1. Process x402 Payment Signature
    if (x402Sig) {
      try {
        let proof: X402PaymentProof;
        try {
          proof = JSON.parse(Buffer.from(x402Sig, "base64").toString("utf-8"));
        } catch {
          proof = JSON.parse(x402Sig);
        }

        if (!proof.signature || !proof.payer) {
          return { valid: false, reason: "Malformed PAYMENT-SIGNATURE: missing signature or payer address." };
        }

        if (!("resource" in challenge) || !("nonce" in challenge)) {
          return { valid: false, reason: "x402 payments require an x402 challenge." };
        }
        if (proof.nonce !== challenge.nonce) {
          return { valid: false, reason: "Invalid nonce in PAYMENT-SIGNATURE: challenge mismatch." };
        }

        const claim = await this.claimVerifier({
          proof,
          resource: challenge.resource,
          amountUSD: challenge.amount,
          recipient: challenge.recipient,
          network: challenge.network,
        });
        if (!claim.ok) return { valid: false, reason: claim.reason };

        const txHash = claim.txHash;
        if (!(await this.consumeTxHash(txHash))) {
          return { valid: false, reason: "This payment transaction has already been used." };
        }        const receiptId = `rcpt_x402_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
        const amount = challenge.amount;

        const receipt: AgenticPaymentReceipt = {
          receiptId,
          protocol: "x402",
          resource: challenge.resource,
          amount,
          currency: challenge.currency,
          network: challenge.network,
          payer: proof.payer,
          recipient: this.recipient,
          status: "verified",
          txHash,
          signature: proof.signature,
          timestamp: new Date().toISOString(),
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid: `did:pkh:eip155:${proof.payer}`,
          note: `Verified on-chain: USDC transfer to recipient confirmed on ${challenge.network}.`,
        };

        // Persist transaction in SQLite
        try {
          await this.recordPaymentTransaction(receipt, "inbound");
        } catch (error) {
          await this.releaseTxHash(txHash);
          throw error;
        }

        return { valid: true, receipt };
      } catch (err: any) {
        return { valid: false, reason: `Failed to decode PAYMENT-SIGNATURE: ${err.message}` };
      }
    }

    // 2. MPP credentials are cryptographically verified by mppx in handleGatedEndpoint; never accept them from headers alone.
    if (mppAuth && mppAuth.toLowerCase().startsWith("payment ")) {
      return { valid: false, reason: "MPP credentials must be verified through the mppx gateway (handleGatedEndpoint)." };
    }
    return { valid: false, reason: "No payment credentials provided. Expected PAYMENT-SIGNATURE or Authorization: Payment." };
  }

  /**
   * Wrap an existing handler with automatic 402 gatekeeping and payment receipt injection
   */
  async handleGatedEndpoint(
    req: Request,
    resource: string,
    priceUSD: number,
    description: string,
    fulfill: (receipt: AgenticPaymentReceipt) => Promise<any>
  ): Promise<Response> {
    const extractedNonce = this.extractNonce(req.headers);
    const challenge = this.createX402Challenge(resource, priceUSD, description, extractedNonce);

    const hasX402 = Boolean(req.headers.get("PAYMENT-SIGNATURE"));
    const hasMpp = /^payment\s/i.test(req.headers.get("Authorization") || "");
    if (hasMpp && !hasX402) {
      return this.handleMppRequest(req, resource, priceUSD, description, fulfill);
    }

    // Verify if payment headers are attached
    const verification = await this.verifyPayment(req.headers, challenge);

    if (!verification.valid || !verification.receipt) {
      const required = this.createPaymentRequiredResponse(challenge, undefined, hasX402 ? verification.reason : undefined);
      const mppChallenge = await this.issueMppChallenge(req, priceUSD, description);
      if (mppChallenge) required.headers.set("WWW-Authenticate", mppChallenge);
      return required;
    }

    // Payment is valid: Fulfill the premium data
    let result: any;
    try {
      result = await fulfill(verification.receipt);
    } catch (error) {
      if (verification.receipt.txHash) await this.releaseTxHash(verification.receipt.txHash);
      throw error;
    }

    // Attach x402 and MPP receipt headers
    const receiptHeader = Buffer.from(JSON.stringify(verification.receipt)).toString("base64");
    const headers = new Headers({
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": receiptHeader,
      "Payment-Receipt": `id=${verification.receipt.receiptId}, amount=${verification.receipt.amount}, tx=${verification.receipt.txHash}`,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers,
    });
  }

  private createMppx() {
    if (!this.mppSecretKey) return null;
    return Mppx.create({
      methods: [
        tempo.charge({
          recipient: this.recipient as `0x${string}`,
          testnet: this.network.includes("sepolia") || this.network.includes("test"),
        }),
      ],
      secretKey: this.mppSecretKey,
    });
  }

  /** Returns the mppx-signed WWW-Authenticate challenge, or null when MPP is not configured. */
  private async issueMppChallenge(req: Request, priceUSD: number, description: string): Promise<string | null> {
    const mppx = this.createMppx();
    if (!mppx) return null;
    const result = await mppx.charge({ amount: priceUSD.toFixed(2), description })(req.clone() as unknown as Request);
    return result.status === 402 ? result.challenge.headers.get("WWW-Authenticate") : null;
  }

  /** Verify an MPP credential with mppx, fulfill the request and attach the MPP receipt. */
  private async handleMppRequest(
    req: Request,
    resource: string,
    priceUSD: number,
    description: string,
    fulfill: (receipt: AgenticPaymentReceipt) => Promise<any>
  ): Promise<Response> {
    const mppx = this.createMppx();
    if (!mppx) {
      return new Response(JSON.stringify({ error: "MPP payments are not configured (MPP_SECRET_KEY missing)." }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await mppx.charge({ amount: priceUSD.toFixed(2), description })(req.clone() as unknown as Request);
    if (result.status === 402) return result.challenge;

    const receipt: AgenticPaymentReceipt = {
      receiptId: `rcpt_mpp_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
      protocol: "mpp",
      resource,
      amount: priceUSD,
      currency: "USDC",
      network: this.network,
      payer: "mpp-credential",
      recipient: this.recipient,
      status: "verified",
      txHash: "",
      timestamp: new Date().toISOString(),
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: "did:mpp:credential",
      note: "Verified by the mppx SDK (Machine Payments Protocol).",
    };
    await this.recordPaymentTransaction(receipt, "inbound");

    const data = await fulfill(receipt);
    return result.withReceipt(
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as Response;
  }
  // =========================================================================
  // 2. Client-Side Buyer: Autonomous Outbound Micropayments with HITL
  // =========================================================================

  /**
   * Sign an x402 payment proof for an outbound payment challenge
   */
  async signPaymentProof(
    challenge: X402PaymentChallenge | MppChallenge,
    payerAddress: string = this.agentWalletAddress
  ): Promise<{ x402Proof?: X402PaymentProof; mppProof?: MppPaymentProof; headers: Record<string, string> }> {
    const timestamp = Date.now();
    const nonce = "nonce" in challenge ? challenge.nonce : `n_${timestamp}`;
    const amount = "amount" in challenge ? challenge.amount : 0.05;

    // Cryptographic signature simulation (compatible with EIP-712 / viem signature standard)
    const payloadToSign = `${payerAddress}:${challenge.recipient}:${amount}:${nonce}:${timestamp}`;
    const signature = `0x_sig_${Buffer.from(payloadToSign).toString("hex").slice(0, 64)}`;
    const txHash = `0x_tx_${crypto.randomUUID().replace(/-/g, "")}`;

    const x402Proof: X402PaymentProof = {
      signature,
      payer: payerAddress,
      txHash,
      nonce,
      timestamp,
      facilitatorToken: `fac_tok_${Date.now()}`,
    };

    const x402Header = Buffer.from(JSON.stringify(x402Proof)).toString("base64");

    return {
      x402Proof,
      headers: {
        "PAYMENT-SIGNATURE": x402Header,
      },
    };
  }

  /**
   * Perform an HTTP fetch with automatic 402 detection, payment signing, and HITL gate
   */
  async requestWithAgenticPayment<T = any>(
    url: string,
    init: RequestInit = {},
    onConfirmationRequired?: PaymentRequiredCallback
  ): Promise<{ success: boolean; data?: T; receipt?: AgenticPaymentReceipt; error?: string; status: number }> {
    // 1. Initial request
    let res = await fetch(url, init);

    // If resource is not 402-gated, return direct response
    if (res.status !== 402) {
      if (!res.ok) {
        return { success: false, status: res.status, error: `Upstream HTTP ${res.status}: ${res.statusText}` };
      }
      const data = (await res.json().catch(() => ({}))) as T;
      return { success: true, status: res.status, data };
    }

    // 2. Parse 402 Payment Challenge
    const paymentReqHeader = res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required");
    const wwwAuthHeader = res.headers.get("WWW-Authenticate") || res.headers.get("www-authenticate");

    let challenge: X402PaymentChallenge;
    if (paymentReqHeader) {
      try {
        challenge = JSON.parse(Buffer.from(paymentReqHeader, "base64").toString("utf-8"));
      } catch {
        challenge = JSON.parse(paymentReqHeader);
      }
    } else {
      challenge = this.createX402Challenge(new URL(url).pathname, 0.05, "Agentic Resource");
    }

    // 3. Human-in-the-Loop (HITL) Gate: Check if amount exceeds auto-approval limit
    const cost = Number(challenge.amount);
    if (cost > this.autoApproveLimitUSD) {
      if (onConfirmationRequired) {
        const approved = await onConfirmationRequired(challenge);
        if (!approved) {
          return {
            success: false,
            status: 402,
            error: `Agentic payment of $${cost.toFixed(2)} ${challenge.currency} for "${challenge.description}" was rejected by Human Authorization (HITL safety rule).`,
          };
        }
      } else {
        return {
          success: false,
          status: 402,
          error: `Payment of $${cost.toFixed(2)} exceeds auto-approval threshold of $${this.autoApproveLimitUSD.toFixed(2)}. Human confirmation required.`,
        };
      }
    }

    // 4. Sign payment proof & retry request with credentials
    const { headers: paymentHeaders, x402Proof } = await this.signPaymentProof(challenge);

    const mergedHeaders = new Headers(init.headers || {});
    for (const [k, v] of Object.entries(paymentHeaders)) {
      mergedHeaders.set(k, v);
    }

    const paidRes = await fetch(url, {
      ...init,
      headers: mergedHeaders,
    });

    if (!paidRes.ok) {
      const errText = await paidRes.text().catch(() => "");
      return {
        success: false,
        status: paidRes.status,
        error: `Paid request retry failed [HTTP ${paidRes.status}]: ${errText.slice(0, 150)}`,
      };
    }

    const data = (await paidRes.json().catch(() => ({}))) as T;

    // Parse receipt from response header
    let receipt: AgenticPaymentReceipt;
    const respHeader = paidRes.headers.get("PAYMENT-RESPONSE");
    if (respHeader) {
      try {
        receipt = JSON.parse(Buffer.from(respHeader, "base64").toString("utf-8"));
      } catch {
        receipt = this.synthesizeReceipt(challenge, x402Proof?.txHash);
      }
    } else {
      receipt = this.synthesizeReceipt(challenge, x402Proof?.txHash);
    }

    // Record outbound transaction
    await this.recordPaymentTransaction(receipt, "outbound");

    return {
      success: true,
      status: paidRes.status,
      data,
      receipt,
    };
  }

  private synthesizeReceipt(challenge: X402PaymentChallenge, txHash?: string): AgenticPaymentReceipt {
    return {
      receiptId: `rcpt_out_${Date.now()}`,
      protocol: "x402",
      resource: challenge.resource,
      amount: challenge.amount,
      currency: challenge.currency,
      network: challenge.network,
      payer: this.agentWalletAddress,
      recipient: challenge.recipient,
      status: "paid",
      txHash: txHash || `0x_tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      proposerDid: AGENT_DIDS.TRADING,
      note: `Outbound micropayment for ${challenge.description}`,
    };
  }

  // =========================================================================
  // 3. Ledger, Wallet Status & Persistence
  // =========================================================================

  /**
   * Persist transaction in SQLite ORM and emit audit event
   */
  async recordPaymentTransaction(
    receipt: AgenticPaymentReceipt,
    direction: "inbound" | "outbound"
  ): Promise<TransactionRecord> {
    const now = new Date().toISOString();
    const action = direction === "inbound" ? ("agentic_payment" as const) : ("micropayment" as const);
    const txRecord: TransactionRecord = {
      id: `tx_${receipt.receiptId}`,
      sessionId: this.sessionId,
      action,
      amount: receipt.amount,
      currency: receipt.currency,
      customer: direction === "inbound" ? receipt.payer : receipt.recipient,
      gateway: receipt.protocol === "mpp" ? "mpp" : "x402",
      gatewayRef: receipt.txHash || receipt.receiptId,
      status: "completed",
      checkoutUrl: receipt.resource,
      proposerDid: receipt.proposerDid,
      authorizerDid: receipt.authorizerDid || `did:key:${receipt.payer}`,
      proofSignature: receipt.signature || `sig_${receipt.receiptId}`,
      note: receipt.note || `Cloudflare Agentic Payment (${(receipt.protocol || "x402").toUpperCase()}) on ${receipt.network || this.network}`,
      createdAt: now,
      updatedAt: now,
    };

    if (this.orm?.transactions) {
      this.orm.transactions.create(txRecord);
    }

    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_pay_${Date.now()}`,
        sessionId: this.sessionId,
        type: direction === "inbound" ? "AGENTIC_PAYMENT_COLLECTED" : "AGENTIC_PAYMENT_SUBMITTED",
        agent: "trading",
        payload: {
          receiptId: receipt.receiptId,
          protocol: receipt.protocol,
          resource: receipt.resource,
          amount: receipt.amount,
          currency: receipt.currency,
          payer: receipt.payer,
          recipient: receipt.recipient,
          txHash: receipt.txHash,
          direction,
        },
        createdAt: now,
      });
    }

    return txRecord;
  }

  /**
   * Get real-time status of Agent Wallet and micropayment metrics
   */
  async getWalletStatus(): Promise<AgenticWalletStatus> {
    let totalSpent = 0;
    let totalEarned = 0;
    let count = 0;

    if (this.orm?.transactions) {
      const allTx = this.orm.transactions.findMany();
      for (const tx of allTx) {
        if (tx.gateway === "x402" || tx.gateway === "mpp") {
          count++;
          if (tx.action === "agentic_payment" || tx.action === "charge") {
            totalEarned += tx.amount;
          } else if (tx.action === "micropayment" || tx.action === "payout") {
            totalSpent += tx.amount;
          }
        }
      }
    }

    // Default simulated balance starting at $50.00 USDC
    const startingBalance = 50.0;
    const currentBalance = Math.max(0, startingBalance + totalEarned - totalSpent);

    return {
      walletAddress: this.agentWalletAddress,
      network: this.network,
      balanceUSD: currentBalance,
      autoApproveLimitUSD: this.autoApproveLimitUSD,
      facilitatorUrl: this.facilitatorUrl,
      protocol: "hybrid",
      totalSpentUSD: totalSpent,
      totalEarnedUSD: totalEarned,
      transactionCount: count,
    };
  }

  /**
   * Set auto-approval threshold for Human-in-the-Loop protection
   */
  setAutoApproveLimit(limitUSD: number): void {
    if (limitUSD < 0) throw new Error("Auto-approval limit cannot be negative.");
    this.autoApproveLimitUSD = limitUSD;
  }

  getAutoApproveLimit(): number {
    return this.autoApproveLimitUSD;
  }
}
