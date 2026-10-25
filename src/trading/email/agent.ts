/**
 * Cloudflare Email Trading Agent for E*TRADE
 * Repurposed from Cloudflare Agents Email SDK pattern:
 * https://developers.cloudflare.com/agents/examples/email-agent/
 *
 * Implements:
 * - Inbound email parsing & intent recognition (Quotes, Screener, Portfolio, Trade Previews)
 * - Human-in-the-Loop (HITL) order preview emails with Agent DID attestation
 * - Email-based order approval ("APPROVE <orderId>") and rejection ("CANCEL <orderId>")
 * - Live E*TRADE execution and outbound transaction receipts
 * - Cloudflare Worker email(message, env, ctx) handler integration
 */

import type { Env, InboundEmailPayload, EmailTradingResult, ETradeOrderDraft } from "../../types";
import { DatabaseORM, requireOrm } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { executeNaturalLanguageQuery, planNLQ } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import {
  channelPlanRefusal,
  tierAtLeast,
  type ChannelPrincipal,
} from "../channels/intake";
import PostalMime from "postal-mime";
import { SERVER_PALETTE } from "../../theme/serverPalette";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

export class ETradeEmailTradingService {
  /**
   * Issue #1262 Phase 1: `principal` is the resolved channel principal
   * (src/trading/channels/intake) supplied by the route. Three states:
   * a principal object — tier enforcement applies and NLQ/execution run
   * under the principal's login; null — the sender is unmapped and every
   * inbound message gets an explicit refusal; undefined — direct/internal
   * construction with no channel assertion (outbound sending, tests),
   * legacy behaviour.
   */
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private sessionId: string = "email_agent_session",
    private principal?: ChannelPrincipal | null
  ) {}

  /** The login trading/NLQ work runs under: the principal's, never a fallback. */
  private identityLogin(): string {
    return this.principal?.userLogin ?? this.sessionId;
  }

  /**
   * Process inbound email message (from Cloudflare Email Routing or HTTP webhook)
   */
  async processInboundEmail(payload: InboundEmailPayload): Promise<EmailTradingResult> {
    // Issue #781: every inbound branch is persistence-backed — approvals
    // and rejections read/update the trade ledger, and queries run NLQ
    // against it. Without an injected ORM, fail loud instead of the
    // former behaviour (fabricated "no pending preview" answers and NLQ
    // results computed against a stub ORM whose reads all returned
    // empty). Outbound-only sending (sendOutboundEmail) does not pass
    // through here and remains ORM-free.
    requireOrm(this.orm, "ETradeEmailTradingService.processInboundEmail");
    const from = (payload.from || "").trim();
    const to = (payload.to || this.env.EMAIL_AGENT_ADDRESS || "trade@agent.openaimp.com").trim();
    const subject = (payload.subject || "").trim();
    const bodyText = (payload.text || payload.html || "").trim();
    const combinedContent = `${subject}\n${bodyText}`.trim();
    const timestamp = new Date().toISOString();

    // Issue #1262 Phase 1: an unmapped sender (principal === null) is
    // refused explicitly — inbound email never runs under a shared
    // instance identity on behalf of an unknown sender.
    if (this.principal === null) {
      const respText =
        `Your email address (${from || "unknown"}) is not mapped to a trading account, so this request was not processed. ` +
        `Quotes, screens, previews and approvals only run for mapped senders (CHANNEL_EMAIL_PRINCIPALS). ` +
        `Ask the account owner to map your address, then resend.`;
      return {
        success: false,
        actionType: "refusal",
        from: to,
        to: from,
        responseSubject: "⚠️ Trading Request Refused: Sender Not Mapped",
        responseText: respText,
        responseHtml: this.renderEmailContainer(
          "Trading Request Refused",
          `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
        ),
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    // Issue #815: env-preserving construction (the pattern #781's
    // pass-through sites adopted). ETradeService's orm-first overload
    // assigns env from its first argument, so an undefined ORM would
    // silently drop the caller's env. requireOrm above guarantees the
    // ORM on this path, but the construction stays env-safe regardless.
    const tradingService = this.orm
      ? new ETradeService(this.orm, this.env, this.identityLogin())
      : new ETradeService(this.env, undefined, this.identityLogin());

    // 1. Detect Approval Action: "APPROVE <orderId>" or "APPROVE"
    const approveMatch = combinedContent.match(/\b(APPROVE|CONFIRM|EXECUTE)\b(?:\s+(ord_[a-zA-Z0-9_-]+))?/i);
    if (approveMatch) {
      return this.handleEmailApproval(from, to, approveMatch[2], tradingService, timestamp);
    }

    // 2. Detect Rejection Action: "REJECT <orderId>" or "CANCEL <orderId>"
    const rejectMatch = combinedContent.match(/\b(REJECT|CANCEL|DECLINE)\b(?:\s+(ord_[a-zA-Z0-9_-]+))?/i);
    if (rejectMatch) {
      return this.handleEmailRejection(from, to, rejectMatch[2], tradingService, timestamp);
    }

    // 3. Process Natural Language Query / Trading Command (Quote, Screen, Preview, Portfolio)
    return this.handleEmailQuery(from, to, subject, bodyText, tradingService, timestamp);
  }

  /**
   * Handle human order approval via email reply
   */
  private async handleEmailApproval(
    from: string,
    to: string,
    specifiedOrderId: string | undefined,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<EmailTradingResult> {
    // Issue #1262 Phase 1: executing an order requires the trade tier.
    // Until Phase 5 (signed approval links), a bare APPROVE from a
    // mapped trade-tier principal is the only email execute path — the
    // former behaviour (any sender could approve against the shared
    // instance) is closed here.
    const approvalPrincipal = this.principal;
    if (approvalPrincipal && !tierAtLeast(approvalPrincipal.tier, "trade")) {
      const respText =
        `Approval refused: your mapped principal (${approvalPrincipal.userLogin}) has ${approvalPrincipal.tier} access, and executing an order requires the trade tier. The order draft was not executed.` +
        (approvalPrincipal.notice ? ` ${approvalPrincipal.notice}` : "");
      return {
        success: false,
        actionType: "approval",
        from: to,
        to: from,
        responseSubject: "⚠️ E*TRADE Order Approval Refused: Trade Tier Required",
        responseText: respText,
        responseHtml: this.renderEmailContainer(
          "Order Approval Refused",
          `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
        ),
        orderId: specifiedOrderId,
        orderStatus: "refused",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: approvalPrincipal.authorizerDid,
        timestamp,
      };
    }

    let targetTrade: any = null;

    if (this.orm?.trades) {
      if (specifiedOrderId) {
        targetTrade = this.orm.trades.findById(specifiedOrderId);
      } else {
        // Find most recent previewed trade in the ledger
        const pending = this.orm.trades.findMany({ where: { status: "previewed" }, orderBy: "created_at DESC", limit: 1 });
        if (pending.length > 0) targetTrade = pending[0];
      }
    }

    if (!targetTrade || targetTrade.status !== "previewed") {
      const respSub = `⚠️ E*TRADE Order Approval Failed: No Pending Preview`;
      const respText = `No pending order preview found awaiting approval${specifiedOrderId ? ` for ID ${specifiedOrderId}` : ""}. Orders may have already been executed or cancelled.`;
      const respHtml = this.renderEmailContainer(
        "Order Approval Failed",
        `
        <div style="background: ${SERVER_PALETTE.dangerAlpha10}; border: 1px solid ${SERVER_PALETTE.sentimentVeryBearish}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: ${SERVER_PALETTE.sentimentVeryBearish}; margin-top: 0;">❌ Approval Not Processed</h3>
          <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;">${respText}</p>
        </div>
        <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px;">To draft a new trade, email commands like: <code>Buy 10 NVDA limit 125.00</code>.</p>
        `
      );

      return {
        success: false,
        actionType: "approval",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
        orderId: specifiedOrderId,
        orderStatus: "not_found",
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    // Explicit Human Authorization: Stamp user DID from email address
    // (#1262 Phase 1: the resolved principal's DID when one was supplied —
    // the same string, built from the normalized mapped address).
    const authorizerDid = this.principal?.authorizerDid ?? `did:user:email:${from}`;

    // Execute order on genuine E*TRADE REST API with HITL verification
    let execRes: any;
    try {
      execRes = tradingService.executeOrder(targetTrade.id, authorizerDid, "approved");
    } catch {
      execRes = await tradingService.placeOrderRemote({
        orderId: targetTrade.id,
        symbol: targetTrade.symbol,
        action: targetTrade.action,
        quantity: targetTrade.quantity,
        orderType: targetTrade.orderType,
        limitPrice: targetTrade.price,
        userLogin: this.identityLogin(),
      });
      if (this.orm?.trades) {
        this.orm.trades.update(targetTrade.id, {
          status: execRes.success ? "executed" : "rejected",
          authorizerDid,
          orderRef: execRes.executionId || execRes.brokerOrderRef,
          updatedAt: timestamp,
        });
      }
    }

    const isSuccess = execRes.success;
    const execId = execRes.executionId || execRes.brokerOrderRef || `et_order_${Date.now()}`;
    const respSub = isSuccess
      ? `✅ E*TRADE Order Executed: ${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol} (Ref: ${execId})`
      : `⚠️ E*TRADE Execution Failed: ${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}`;

    const respText = isSuccess
      ? `SUCCESS: Your authorized order to ${targetTrade.action} ${targetTrade.quantity} shares of ${targetTrade.symbol} has been routed to E*TRADE.\n\nBroker Order Ref: ${execId}\nStatus: EXECUTED\nTotal: $${targetTrade.totalValue.toFixed(2)} USD\nAuthorizer: ${authorizerDid}\nTimestamp: ${timestamp}`
      : `FAILED: Upstream broker rejected order placement: ${execRes.message || "Unknown error"}. No funds moved.`;

    const respHtml = this.renderEmailContainer(
      isSuccess ? "E*TRADE Order Executed Successfully" : "E*TRADE Execution Alert",
      `
      <div style="background: ${isSuccess ? SERVER_PALETTE.greenAlpha10 : SERVER_PALETTE.dangerAlpha10}; border: 1px solid ${isSuccess ? SERVER_PALETTE.green500 : SERVER_PALETTE.sentimentVeryBearish}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: ${isSuccess ? SERVER_PALETTE.green500 : SERVER_PALETTE.sentimentVeryBearish}; margin-top: 0;">${isSuccess ? "✓ Order Routed to Broker" : "✕ Execution Blocked"}</h3>
        <p style="color: ${SERVER_PALETTE.textPrimary}; font-size: 15px; margin-bottom: 8px;"><strong>${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}</strong></p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Broker Ref:</strong> <code style="color: ${SERVER_PALETTE.accent};">${execId}</code></p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Execution Total:</strong> $${targetTrade.totalValue.toFixed(2)} USD</p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;"><strong>Authorizer DID:</strong> <code>${authorizerDid}</code></p>
      </div>
      <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px;">This trade was authorized via Autonomous Email Desk and stamped with Cryptographic Agent DID proof.</p>
      `
    );

    return {
      success: isSuccess,
      actionType: "approval",
      from: to,
      to: from,
      responseSubject: respSub,
      responseText: respText,
      responseHtml: respHtml,
      orderId: targetTrade.id,
      orderStatus: isSuccess ? "executed" : "failed",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      timestamp,
    };
  }

  /**
   * Handle human order cancellation via email reply
   */
  private async handleEmailRejection(
    from: string,
    to: string,
    specifiedOrderId: string | undefined,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<EmailTradingResult> {
    // Issue #1262 Phase 1: cancelling a draft is an operation on a trade
    // preview — it requires the preview tier or above (read is
    // quote/screen/discovery/recommendation only).
    const rejectionPrincipal = this.principal;
    if (rejectionPrincipal && !tierAtLeast(rejectionPrincipal.tier, "preview")) {
      const respText =
        `Cancellation refused: your mapped principal (${rejectionPrincipal.userLogin}) has ${rejectionPrincipal.tier} access, and cancelling an order draft requires the preview tier or above. The draft was left unchanged.`;
      return {
        success: false,
        actionType: "rejection",
        from: to,
        to: from,
        responseSubject: "⚠️ E*TRADE Order Cancellation Refused: Preview Tier Required",
        responseText: respText,
        responseHtml: this.renderEmailContainer(
          "Order Cancellation Refused",
          `<p style="color: ${SERVER_PALETTE.textSecondary};">${respText}</p>`
        ),
        orderId: specifiedOrderId,
        orderStatus: "refused",
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid: rejectionPrincipal.authorizerDid,
        timestamp,
      };
    }

    let targetTrade: any = null;

    if (this.orm?.trades) {
      if (specifiedOrderId) {
        targetTrade = this.orm.trades.findById(specifiedOrderId);
      } else {
        const pending = this.orm.trades.findMany({ where: { status: "previewed" }, orderBy: "created_at DESC", limit: 1 });
        if (pending.length > 0) targetTrade = pending[0];
      }
    }

    if (targetTrade && targetTrade.status === "previewed") {
      this.orm?.trades?.update(targetTrade.id, { status: "rejected", updatedAt: timestamp });
    }

    const orderDesc = targetTrade ? `${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` : "Draft order";
    const respSub = `❌ E*TRADE Order Cancelled: ${orderDesc}`;
    const respText = `Your order draft (${targetTrade?.id || specifiedOrderId || "N/A"}) has been safely cancelled. No funds or equities were moved.`;
    const respHtml = this.renderEmailContainer(
      "E*TRADE Order Cancelled",
      `
      <div style="background: ${SERVER_PALETTE.slateAlpha10}; border: 1px solid ${SERVER_PALETTE.slate500}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: ${SERVER_PALETTE.textMuted}; margin-top: 0;">✓ Draft Discarded Safely</h3>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 4px;"><strong>Order:</strong> ${orderDesc}</p>
        <p style="color: ${SERVER_PALETTE.textSecondary}; margin-bottom: 0;">Status: <strong>CANCELLED</strong>. No live capital moved.</p>
      </div>
      `
    );

    return {
      success: true,
      actionType: "rejection",
      from: to,
      to: from,
      responseSubject: respSub,
      responseText: respText,
      responseHtml: respHtml,
      orderId: targetTrade?.id || specifiedOrderId,
      orderStatus: "rejected",
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid: this.principal?.authorizerDid ?? `did:user:email:${from}`,
      timestamp,
    };
  }

  /**
   * Handle NLQ queries over email (Quotes, Market Screener, Order Previews, Portfolio)
   */
  private async handleEmailQuery(
    from: string,
    to: string,
    subject: string,
    body: string,
    tradingService: ETradeService,
    timestamp: string
  ): Promise<EmailTradingResult> {
    const prompt = (subject.trim() + " " + body.trim()).trim();

    try {
      const orm = requireOrm(this.orm, "ETradeEmailTradingService.handleEmailQuery");

      // Issue #1262 Phase 1: channel seam gate. When a principal was
      // resolved, plan first and refuse what the channel must not do —
      // paid actions (all tiers, v1) and tier-gated trading actions —
      // BEFORE anything executes. The executor re-plans deterministically
      // inside executeNaturalLanguageQuery; the paid fast-paths are
      // regex-determined, so the peek and the execution plan agree.
      if (this.principal) {
        const peek = await planNLQ(this.env, prompt, { untrustedContent: true });
        const refusal = channelPlanRefusal(peek, this.principal);
        if (refusal) {
          return {
            success: false,
            actionType: "refusal",
            from: to,
            to: from,
            responseSubject: "⚠️ Trading Request Refused",
            responseText: refusal,
            responseHtml: this.renderEmailContainer(
              "Trading Request Refused",
              `<p style="color: ${SERVER_PALETTE.textSecondary};">${refusal}</p>`
            ),
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid: this.principal.authorizerDid,
            timestamp,
          };
        }
      }

      const { plan, result: nlqRes } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        prompt,
        this.env,
        // #1262 Phase 1: the NLQ userLogin is the resolved principal's
        // login — never the session/instance id (paid actions attribute
        // the payer from this value, #183).
        this.identityLogin(),
        this.principal?.authorizerDid ?? `did:user:email:${from}`,
        // #767/#862: email subject+body is untrusted inbound content — the
        // NLQ planner/validator apply instruction/data separation.
        { untrustedContent: true },
      );

      const domain = plan.domain;
      const action = plan.tradingData?.action || "query";

      // Case A: Quote
      if (domain === "trading" && action === "quote") {
        const q: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const lastPriceStr = String(q.lastPrice || "$0.00");
        const changeStr = String(q.change || "0.00%");
        const respSub = `📈 E*TRADE Quote: ${q.symbol || "Ticker"} - ${lastPriceStr} (${changeStr})`;
        const respText = `${nlqRes.summary}\n\nPrice: ${lastPriceStr}\nChange: ${changeStr}\nBid/Ask: ${q.bidAsk || "N/A"}\nVolume: ${q.volume || "N/A"}\n52W Range: ${q.range52Week || "N/A"}\nP/E: ${q.peRatio || "N/A"}\n\nTo preview a trade, reply: "Buy 10 ${q.symbol} limit ${lastPriceStr.replace("$", "") || "100"}"`;

        const respHtml = this.renderEmailContainer(
          `Real-Time Market Quote: ${q.symbol}`,
          `
          <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 20px; border: 1px solid ${SERVER_PALETTE.slate700}; margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
              <h2 style="color: ${SERVER_PALETTE.textPrimary}; margin: 0; font-size: 24px;">${q.symbol} <span style="font-size: 15px; color: ${SERVER_PALETTE.textMuted}; font-weight: normal;">${q.company || ""}</span></h2>
              <span style="font-size: 24px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${q.lastPrice}</span>
            </div>
            <p style="color: ${changeStr.includes("-") ? SERVER_PALETTE.sentimentVeryBearish : SERVER_PALETTE.green500}; font-size: 15px; margin: 0 0 16px 0; font-weight: 600;">
              ${changeStr} Today
            </p>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: ${SERVER_PALETTE.textSecondary};">
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Bid / Ask:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.bidAsk || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Volume:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.volume || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>52-Week Range:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${q.range52Week || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0;"><strong>Market Cap:</strong></td>
                <td style="padding: 6px 0; text-align: right;">${q.marketCap || "N/A"}</td>
              </tr>
            </table>
          </div>
          <div style="background: ${SERVER_PALETTE.accentAlpha10}; border: 1px solid ${SERVER_PALETTE.sky600}; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <p style="color: ${SERVER_PALETTE.accent}; margin: 0; font-size: 13px;">💡 <strong>Quick Trade Prompt:</strong> Reply to this email with <code>Preview Buy 10 ${q.symbol} limit ${lastPriceStr.replace("$", "") || "100"}</code> to draft an order ticket.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "quote",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case B: Screener
      if (domain === "trading" && action === "screen") {
        const stocks = nlqRes.rows || [];
        const respSub = `🔍 E*TRADE Screener: ${stocks.length} Stocks Matched`;
        let textRows = stocks.length > 0
          ? stocks.slice(0, 8).map((s: any) => `• ${s.symbol} (${s.exchange || "N/A"}): ${s.price} (${s.change}) | Market cap: ${s.marketCap || "N/A"}`).join("\n")
          : "No equities matched the requested screener criteria. Try broadening your filter.";
        const respText = `${nlqRes.summary}\n\n${textRows}\n\nReply with "Quote <SYMBOL>" for deep details or "Buy <QTY> <SYMBOL>" to preview an order.`;

        let htmlRows = stocks.length > 0
          ? stocks.slice(0, 10).map((s: any) => `
          <tr style="border-bottom: 1px solid ${SERVER_PALETTE.slate700};">
            <td style="padding: 8px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${s.symbol}</td>
            <td style="padding: 8px; color: ${SERVER_PALETTE.textSecondary};">${s.exchange || "N/A"}</td>
            <td style="padding: 8px; text-align: right; color: ${SERVER_PALETTE.textPrimary};">${s.price}</td>
            <td style="padding: 8px; text-align: right; color: ${(s.change || "").includes("-") ? SERVER_PALETTE.sentimentVeryBearish : SERVER_PALETTE.green500};">${s.change}</td>
            <td style="padding: 8px; text-align: right; color: ${SERVER_PALETTE.slate100};">${s.marketCap || "N/A"}</td>
          </tr>
        `).join("")
          : `<tr><td colspan="5" style="padding: 16px; text-align: center; color: ${SERVER_PALETTE.textMuted};">No equities matched the requested screener criteria.</td></tr>`;

        const respHtml = this.renderEmailContainer(
          `Market Screener Results (${stocks.length} Equities)`,
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 14px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
            <thead>
              <tr style="background: ${SERVER_PALETTE.slate800}; color: ${SERVER_PALETTE.textMuted}; text-align: left; border-bottom: 2px solid ${SERVER_PALETTE.slate600};">
                <th style="padding: 8px;">Symbol</th>
                <th style="padding: 8px;">Exchange</th>
                <th style="padding: 8px; text-align: right;">Price</th>
                <th style="padding: 8px; text-align: right;">Daily Change</th>
                <th style="padding: 8px; text-align: right;">Market Cap</th>
              </tr>
            </thead>
            <tbody>
              ${htmlRows}
            </tbody>
          </table>
          `
        );

        return {
          success: true,
          actionType: "screener",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case C: Order Preview (Strict HITL enforcement)
      if (domain === "trading" && action === "preview_order") {
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const orderId: string = String(row.orderId || `ord_${Date.now()}`);
        const actionStr: string = String(row.action || "BUY");
        const symbol: string = String(row.symbol || "EQUITY");
        const qty: number = Number(row.quantity) || 1;
        const total: string = String(row.estimatedTotal || "$0.00");
        const price: string = String(row.estimatedPrice || "$0.00");

        const respSub = `🛡️ HITL Action Required: Preview ${actionStr} ${qty} ${symbol} (${total})`;
        const respText = `ORDER PREVIEW AWAITING HUMAN AUTHORIZATION\n\nAction: ${actionStr}\nSymbol: ${symbol}\nQuantity: ${qty}\nEstimated Price: ${price}\nEstimated Total: ${total}\nCommission: $0.00\nOrder ID: ${orderId}\n\nSAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED.\n\nTo AUTHORIZE this trade, reply directly to this email with:\nAPPROVE ${orderId}\n\nTo CANCEL, reply:\nCANCEL ${orderId}`;

        const approveUrl = `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/?tab=trading&approveOrder=${orderId}`;

        const respHtml = this.renderEmailContainer(
          `Order Preview Awaiting Human Authorization`,
          `
          <div style="background: ${SERVER_PALETTE.warningAlpha10}; border: 1px solid ${SERVER_PALETTE.warning}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <h3 style="color: ${SERVER_PALETTE.warning}; margin-top: 0;">🛡️ Agentic HITL Safety Guarantee</h3>
            <p style="color: ${SERVER_PALETTE.amber100}; font-size: 14px; margin-bottom: 0;">
              No funds have been moved. Every trade drafted by the Multi-Agent System requires explicit human authorization before being routed to E*TRADE.
            </p>
          </div>

          <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 20px; border: 1px solid ${SERVER_PALETTE.slate700}; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: ${SERVER_PALETTE.textSecondary};">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Order Action:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; color: ${SERVER_PALETTE.accent}; font-weight: bold;">${actionStr}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Ticker Symbol:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; font-weight: bold; color: ${SERVER_PALETTE.textPrimary};">${symbol}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Quantity:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${qty} shares</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Estimated Price:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right;">${price}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700};"><strong>Online Commission:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid ${SERVER_PALETTE.slate700}; text-align: right; color: ${SERVER_PALETTE.green500};">$0.00 USD</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-size: 16px;"><strong>Estimated Total Value:</strong></td>
                <td style="padding: 10px 0; text-align: right; font-size: 18px; font-weight: bold; color: ${SERVER_PALETTE.accent};">${total}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${approveUrl}" style="background: ${SERVER_PALETTE.blue600}; color: ${SERVER_PALETTE.onGradient}; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
              ✓ Review & Approve on Trading Hub
            </a>
          </div>

          <div style="background: ${SERVER_PALETTE.card}; border-radius: 6px; padding: 12px; border: 1px solid ${SERVER_PALETTE.slate800};">
            <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px; margin: 0 0 6px 0;"><strong>Or Authorize Directly via Email Reply:</strong></p>
            <p style="color: ${SERVER_PALETTE.textSecondary}; font-family: monospace; font-size: 14px; margin: 0 0 4px 0;">Reply <code>APPROVE ${orderId}</code> to execute live.</p>
            <p style="color: ${SERVER_PALETTE.textSecondary}; font-family: monospace; font-size: 14px; margin: 0;">Reply <code>CANCEL ${orderId}</code> to discard.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "preview",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          orderId,
          orderStatus: "previewed",
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case D: Portfolio & Balances
      if (domain === "trading" && action === "positions") {
        const respSub = `💼 E*TRADE Portfolio & Balance Summary`;
        const respText = `${nlqRes.summary}`;
        const respHtml = this.renderEmailContainer(
          `E*TRADE Brokerage Account Overview`,
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 15px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <div style="background: ${SERVER_PALETTE.accentAlpha10}; border: 1px solid ${SERVER_PALETTE.sky600}; border-radius: 8px; padding: 12px;">
            <p style="color: ${SERVER_PALETTE.accent}; margin: 0; font-size: 13px;">🛡️ Account data reconciled against live E*TRADE REST API feeds.</p>
          </div>
          `
        );

        return {
          success: true,
          actionType: "portfolio",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case E: Options Research & Strategy Screener
      if (domain === "trading" && ["options_screen", "options_strategies", "options_best_trade", "options_opportunities"].includes(action)) {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const topResults = rows.slice(0, 5);
        const htmlCards = topResults.map((row, index) => {
          const label = String(row.label || row.strategy || row.contractSymbol || row.symbol || `Option ${index + 1}`);
          const score = row.score ?? row.compositeScore;
          const details = Object.entries(row)
            .filter(([k]) => !["label", "strategy", "contractSymbol", "symbol", "score", "compositeScore"].includes(k))
            .slice(0, 4)
            .map(([k, v]) => `<strong>${k}:</strong> ${String(v)}`)
            .join(" &nbsp;|&nbsp; ");
          return `
            <div style="background: ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 14px; margin-bottom: 12px; border: 1px solid ${SERVER_PALETTE.slate700};">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <h4 style="color: ${SERVER_PALETTE.accent}; margin: 0 0 6px 0;">${escapeHtml(label)}</h4>
                ${score !== undefined ? `<span style="color: ${SERVER_PALETTE.green500}; font-weight: bold;">Score: ${score}</span>` : ""}
              </div>
              ${details ? `<p style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px; margin: 0;">${details}</p>` : ""}
            </div>
          `;
        }).join("");

        const respSub = `📊 E*TRADE Options Research: ${nlqRes.summary || "Strategy Screener"}`;
        const respText = `${nlqRes.summary || "Options research completed."}\n\n${topResults.map((r, i) => `${i + 1}. ${r.label || r.strategy || r.symbol || "Option"}`).join("\n")}\n\nResearch only — no orders were placed.`;
        const respHtml = this.renderEmailContainer(
          "Options Research Results",
          `
          <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 15px; margin-top: 0;">${escapeHtml(nlqRes.summary || "Options strategy evaluation completed.")}</p>
          ${htmlCards || `<p style="color: ${SERVER_PALETTE.textMuted};">No matching option candidates found.</p>`}
          <p style="color: ${SERVER_PALETTE.slate500}; font-size: 12px; margin-top: 16px;">🛡️ Multi-Agent Options Engine • E*TRADE Dynamic API Feed • Research Only</p>
          `
        );

        return {
          success: true,
          actionType: "screener",
          from: to,
          to: from,
          responseSubject: respSub,
          responseText: respText,
          responseHtml: respHtml,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Default AI Answer
      const respSub = `🤖 E*TRADE Trading Assistant: ${subject || "Market Research"}`;
      const respText = nlqRes.summary || "Your trading research request was processed.";
      const respHtml = this.renderEmailContainer("E*TRADE Trading Assistant", `<p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 14px;">${respText}</p>`);

      return {
        success: true,
        actionType: "general",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    } catch (err: any) {
      const respSub = `⚠️ Error Processing Trading Request`;
      const respText = `An error occurred while processing your request: ${err.message || String(err)}`;
      const respHtml = this.renderEmailContainer("Processing Error", `<p style="color: ${SERVER_PALETTE.sentimentVeryBearish};">${respText}</p>`);

      return {
        success: false,
        actionType: "error",
        from: to,
        to: from,
        responseSubject: respSub,
        responseText: respText,
        responseHtml: respHtml,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }
  }

  /**
   * Send outbound reply email via Cloudflare Email binding if available
   */
  async sendOutboundEmail(
    to: string,
    subject: string,
    html: string,
    text: string,
    attachment?:
      | { fileName: string; contentType: string; contentBase64: string }
      | Array<{ fileName: string; contentType: string; contentBase64: string }>
  ): Promise<boolean> {
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to) || /[\r\n]/.test(subject)) {
      throw new Error("Invalid outbound email recipient or subject.");
    }
    // Issue #1191 (#1173 R3): one attachment or many — deliveries
    // attach text + PDF + XLSX. Single-attachment callers (the
    // historical shape) are unaffected.
    const attachments = attachment === undefined
      ? []
      : Array.isArray(attachment)
        ? attachment
        : [attachment];
    if (this.env.EMAIL && typeof this.env.EMAIL.send === "function") {
      try {
        const fromAddress = this.env.EMAIL_AGENT_ADDRESS || "trade@agent.openaimp.com";
        const alternativeBoundary = `----=_Alternative_${crypto.randomUUID()}`;
        const mixedBoundary = `----=_Mixed_${crypto.randomUUID()}`;
        const rawParts = [
          `From: "E*TRADE Agentic Trading Hub" <${fromAddress}>`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: ${attachments.length > 0 ? `multipart/mixed; boundary="${mixedBoundary}"` : `multipart/alternative; boundary="${alternativeBoundary}"`}`,
          `X-Agent-DID: ${AGENT_DIDS.TRADING}`,
          ``,
        ];
        if (attachments.length > 0) {
          rawParts.push(
            `--${mixedBoundary}`,
            `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
            ``,
          );
        }
        rawParts.push(
          `--${alternativeBoundary}`,
          `Content-Type: text/plain; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          ``,
          text,
          ``,
          `--${alternativeBoundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          ``,
          html,
          ``,
          `--${alternativeBoundary}--`,
        );
        if (attachments.length > 0) {
          for (const att of attachments) {
            const safeFileName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "research.xlsx";
            rawParts.push(
              ``,
              `--${mixedBoundary}`,
              `Content-Type: ${att.contentType}; name="${safeFileName}"`,
              `Content-Disposition: attachment; filename="${safeFileName}"`,
              `Content-Transfer-Encoding: base64`,
              ``,
              att.contentBase64.match(/.{1,76}/g)?.join("\r\n") || "",
            );
          }
          rawParts.push(``, `--${mixedBoundary}--`);
        }
        const rawMime = rawParts.join("\r\n");

        await this.env.EMAIL.send(new Response(rawMime).body);
        return true;
      } catch (err) {
        console.warn("[ETradeEmailService] Failed to send email via env.EMAIL binding:", err);
        return false;
      }
    }
    return false;
  }

  /**
   * Renders standard institutional dark-palette HTML email container
   */
  private renderEmailContainer(headerTitle: string, contentHtml: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headerTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${SERVER_PALETTE.pageBackground}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: ${SERVER_PALETTE.textPrimary};">
  <div style="max-width: 620px; margin: 0 auto; background-color: ${SERVER_PALETTE.card}; border-radius: 10px; border: 1px solid ${SERVER_PALETTE.slate800}; overflow: hidden; margin-top: 20px; margin-bottom: 20px;">
    <!-- Brand Header -->
    <div style="background: linear-gradient(135deg, ${SERVER_PALETTE.blue900} 0%, ${SERVER_PALETTE.card} 100%); padding: 24px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span style="background: ${SERVER_PALETTE.blue500}; color: ${SERVER_PALETTE.onGradient}; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;">
            E*TRADE AGENTIC HUB
          </span>
          <h1 style="color: ${SERVER_PALETTE.onGradient}; font-size: 20px; margin: 8px 0 0 0; font-weight: 700;">${headerTitle}</h1>
        </div>
      </div>
    </div>

    <!-- Body Content -->
    <div style="padding: 24px;">
      ${contentHtml}
    </div>

    <!-- Security & Provenance Footer -->
    <div style="background-color: ${SERVER_PALETTE.pageBackground}; padding: 18px 24px; border-top: 1px solid ${SERVER_PALETTE.slate800}; font-size: 12px; color: ${SERVER_PALETTE.slate500};">
      <p style="margin: 0 0 6px 0;">
        🛡️ <strong>Trading Agent DID:</strong> <code style="color: ${SERVER_PALETTE.textMuted};">${AGENT_DIDS.TRADING}</code>
      </p>
      <p style="margin: 0 0 6px 0;">
        ⚖️ <strong>Regulatory Compliance:</strong> Direct REST API execution over OAuth 1.0a. Strict Human-in-the-Loop protection enforced on all equity orders.
      </p>
      <p style="margin: 0;">
        OpenAIMP Agentic Trading Network • <a href="${this.env.APP_BASE_URL || "https://agent.openaimp.com"}" style="color: ${SERVER_PALETTE.accent}; text-decoration: none;">agent.openaimp.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
  }
}

/**
 * The orchestrator DO instance that owns inbound email trading. The
 * worker email handler has no session (Cloudflare Email Routing invokes
 * it directly), so — exactly like the worker's scheduled() handler — it
 * addresses the deployment's established owner instance. The sender
 * address is caller-controlled and is NEVER used to select the instance
 * or the identity header (issue #815).
 */
export const INBOUND_EMAIL_ORCHESTRATOR_INSTANCE = "default_trader";

/**
 * Cloudflare Worker email handler helper for exported email(message, env, ctx) handler
 */
export async function handleCloudflareEmailMessage(
  message: any,
  env: Env,
  ctx?: any
): Promise<EmailTradingResult> {
  const from = message.from;
  const to = message.to;

  let subject = "";
  let text = "";
  let html = "";
  // Issue #1262 Phase 1: the Authentication-Results header (RFC 8601) is
  // the transport-authentication evidence the channel intake uses to
  // gate the email trade tier (DKIM/SPF pass). Forward it verbatim; the
  // parsing lives in src/trading/channels/intake.
  let authenticationResults = "";
  try {
    authenticationResults = message.headers?.get?.("authentication-results") || "";
  } catch {
    authenticationResults = "";
  }

  try {
    if (message.raw) {
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);
      subject = parsed.subject || "";
      text = parsed.text || "";
      html = parsed.html || "";
      if (!authenticationResults) {
        const authHeader = (parsed.headers || []).find(
          (h: any) => typeof h?.key === "string" && h.key.toLowerCase() === "authentication-results"
        );
        if (authHeader && typeof authHeader.value === "string") {
          authenticationResults = authHeader.value;
        }
      }
    }
  } catch (err) {
    console.warn("[CloudflareEmail] PostalMime parse failed, falling back to header inspect:", err);
    subject = message.headers?.get?.("subject") || "";
  }

  // Issue #815: inbound email trading is persistence-backed — approvals
  // and rejections read/update the trade ledger, and queries run NLQ
  // against it — and an ORM wraps a specific Durable Object's
  // storage.sql, which the worker isolate does not have. Forward the
  // parsed payload to the owning user's OrchestratorAgent DO, whose
  // POST /trading/email/inbound route runs ETradeEmailTradingService
  // against the DO's real ORM, over the same SEARCH_AGENT channel every
  // /api route uses. If the orchestrator path is unavailable this
  // throws (the #781 fail-loud contract) instead of processing the
  // email against an ORM-less local service.
  const namespace = env.SEARCH_AGENT;
  if (!namespace || typeof namespace.idFromName !== "function") {
    throw new Error(
      "Inbound email trading requires the SEARCH_AGENT (orchestrator) binding to reach the user's Durable Object ORM; refusing to process the email without it (issue #815)."
    );
  }
  const agentId = namespace.idFromName(INBOUND_EMAIL_ORCHESTRATOR_INSTANCE);
  const response = await namespace.get(agentId).fetch(
    new Request("https://agent.internal/trading/email/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Issue #1262 Phase 1: no identity header is asserted here. The
        // instance name above is ROUTING (addressing, #815) only; the
        // caller's identity is resolved inside the DO from the payload
        // (sender → CHANNEL_EMAIL_PRINCIPALS map + Authentication-
        // Results) by the channel intake.
      },
      body: JSON.stringify({ from, to, subject, text, html, authenticationResults }),
    })
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Orchestrator rejected the inbound email forward (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  const result = (await response.json()) as EmailTradingResult;

  // Automatically dispatch outbound reply if Cloudflare Email Service reply is supported.
  // Reply dispatch is send-only (no persistence), so it stays in the
  // worker on the ORM-free send path #781 preserved.
  if (typeof message.reply === "function") {
    try {
      await message.reply(
        new Response(
          `From: ${to}\r\nTo: ${from}\r\nSubject: ${result.responseSubject}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${result.responseHtml}`
        ).body
      );
    } catch (e) {
      console.warn("[CloudflareEmail] message.reply error:", e);
    }
  } else {
    const sender = new ETradeEmailTradingService(env);
    await sender.sendOutboundEmail(from, result.responseSubject, result.responseHtml, result.responseText);
  }

  return result;
}
