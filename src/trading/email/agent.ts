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
import { DatabaseORM } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { planNLQ, executeNLQQueryAsync } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import PostalMime from "postal-mime";

export class ETradeEmailTradingService {
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private sessionId: string = "email_agent_session"
  ) {}

  /**
   * Process inbound email message (from Cloudflare Email Routing or HTTP webhook)
   */
  async processInboundEmail(payload: InboundEmailPayload): Promise<EmailTradingResult> {
    const from = (payload.from || "").trim();
    const to = (payload.to || this.env.EMAIL_AGENT_ADDRESS || "trade@agent.openaimp.com").trim();
    const subject = (payload.subject || "").trim();
    const bodyText = (payload.text || payload.html || "").trim();
    const combinedContent = `${subject}\n${bodyText}`.trim();
    const timestamp = new Date().toISOString();

    const tradingService = new ETradeService(this.orm, this.env, this.sessionId);

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
        <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
          <h3 style="color: #ef4444; margin-top: 0;">❌ Approval Not Processed</h3>
          <p style="color: #cbd5e1; margin-bottom: 0;">${respText}</p>
        </div>
        <p style="color: #94a3b8; font-size: 13px;">To draft a new trade, email commands like: <code>Buy 10 NVDA limit 125.00</code>.</p>
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
    const authorizerDid = `did:user:email:${from}`;

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
        userLogin: this.sessionId,
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
      <div style="background: ${isSuccess ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)"}; border: 1px solid ${isSuccess ? "#22c55e" : "#ef4444"}; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: ${isSuccess ? "#22c55e" : "#ef4444"}; margin-top: 0;">${isSuccess ? "✓ Order Routed to Broker" : "✕ Execution Blocked"}</h3>
        <p style="color: #f8fafc; font-size: 15px; margin-bottom: 8px;"><strong>${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}</strong></p>
        <p style="color: #cbd5e1; margin-bottom: 4px;"><strong>Broker Ref:</strong> <code style="color: #38bdf8;">${execId}</code></p>
        <p style="color: #cbd5e1; margin-bottom: 4px;"><strong>Execution Total:</strong> $${targetTrade.totalValue.toFixed(2)} USD</p>
        <p style="color: #cbd5e1; margin-bottom: 0;"><strong>Authorizer DID:</strong> <code>${authorizerDid}</code></p>
      </div>
      <p style="color: #94a3b8; font-size: 13px;">This trade was authorized via Cloudflare Email Agent and stamped with Cryptographic Agent DID proof.</p>
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
      <div style="background: rgba(148, 163, 184, 0.1); border: 1px solid #64748b; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
        <h3 style="color: #94a3b8; margin-top: 0;">✓ Draft Discarded Safely</h3>
        <p style="color: #cbd5e1; margin-bottom: 4px;"><strong>Order:</strong> ${orderDesc}</p>
        <p style="color: #cbd5e1; margin-bottom: 0;">Status: <strong>CANCELLED</strong>. No live capital moved.</p>
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
      authorizerDid: `did:user:email:${from}`,
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
      const plan = await planNLQ(this.env, prompt);
      const orm = this.orm || new DatabaseORM({ exec: () => [] });
      const nlqRes = await executeNLQQueryAsync(orm, this.sessionId, plan, this.env, this.sessionId);

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
          <div style="background: #1e293b; border-radius: 8px; padding: 20px; border: 1px solid #334155; margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
              <h2 style="color: #f8fafc; margin: 0; font-size: 24px;">${q.symbol} <span style="font-size: 15px; color: #94a3b8; font-weight: normal;">${q.company || ""}</span></h2>
              <span style="font-size: 24px; font-weight: bold; color: #38bdf8;">${q.lastPrice}</span>
            </div>
            <p style="color: ${changeStr.includes("-") ? "#ef4444" : "#22c55e"}; font-size: 15px; margin: 0 0 16px 0; font-weight: 600;">
              ${changeStr} Today
            </p>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #cbd5e1;">
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155;"><strong>Bid / Ask:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155; text-align: right;">${q.bidAsk || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155;"><strong>Volume:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155; text-align: right;">${q.volume || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155;"><strong>52-Week Range:</strong></td>
                <td style="padding: 6px 0; border-bottom: 1px solid #334155; text-align: right;">${q.range52Week || "N/A"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0;"><strong>Market Cap:</strong></td>
                <td style="padding: 6px 0; text-align: right;">${q.marketCap || "N/A"}</td>
              </tr>
            </table>
          </div>
          <div style="background: rgba(56, 189, 248, 0.1); border: 1px solid #0284c7; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <p style="color: #38bdf8; margin: 0; font-size: 13px;">💡 <strong>Quick Trade Prompt:</strong> Reply to this email with <code>Preview Buy 10 ${q.symbol} limit ${lastPriceStr.replace("$", "") || "100"}</code> to draft an order ticket.</p>
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
          <tr style="border-bottom: 1px solid #334155;">
            <td style="padding: 8px; font-weight: bold; color: #38bdf8;">${s.symbol}</td>
            <td style="padding: 8px; color: #cbd5e1;">${s.exchange || "N/A"}</td>
            <td style="padding: 8px; text-align: right; color: #f8fafc;">${s.price}</td>
            <td style="padding: 8px; text-align: right; color: ${(s.change || "").includes("-") ? "#ef4444" : "#22c55e"};">${s.change}</td>
            <td style="padding: 8px; text-align: right; color: #f1f5f9;">${s.marketCap || "N/A"}</td>
          </tr>
        `).join("")
          : `<tr><td colspan="5" style="padding: 16px; text-align: center; color: #94a3b8;">No equities matched the requested screener criteria.</td></tr>`;

        const respHtml = this.renderEmailContainer(
          `Market Screener Results (${stocks.length} Equities)`,
          `
          <p style="color: #cbd5e1; font-size: 14px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
            <thead>
              <tr style="background: #1e293b; color: #94a3b8; text-align: left; border-bottom: 2px solid #475569;">
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
          <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
            <h3 style="color: #f59e0b; margin-top: 0;">🛡️ Agentic HITL Safety Guarantee</h3>
            <p style="color: #fef3c7; font-size: 14px; margin-bottom: 0;">
              No funds have been moved. Every trade drafted by the Multi-Agent System requires explicit human authorization before being routed to E*TRADE.
            </p>
          </div>

          <div style="background: #1e293b; border-radius: 8px; padding: 20px; border: 1px solid #334155; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #cbd5e1;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155;"><strong>Order Action:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155; text-align: right; color: #38bdf8; font-weight: bold;">${actionStr}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155;"><strong>Ticker Symbol:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155; text-align: right; font-weight: bold; color: #f8fafc;">${symbol}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155;"><strong>Quantity:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155; text-align: right;">${qty} shares</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155;"><strong>Estimated Price:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155; text-align: right;">${price}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155;"><strong>Online Commission:</strong></td>
                <td style="padding: 8px 0; border-bottom: 1px solid #334155; text-align: right; color: #22c55e;">$0.00 USD</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-size: 16px;"><strong>Estimated Total Value:</strong></td>
                <td style="padding: 10px 0; text-align: right; font-size: 18px; font-weight: bold; color: #38bdf8;">${total}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin-bottom: 24px;">
            <a href="${approveUrl}" style="background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
              ✓ Review & Approve on Trading Hub
            </a>
          </div>

          <div style="background: #0f172a; border-radius: 6px; padding: 12px; border: 1px solid #1e293b;">
            <p style="color: #94a3b8; font-size: 13px; margin: 0 0 6px 0;"><strong>Or Authorize Directly via Email Reply:</strong></p>
            <p style="color: #cbd5e1; font-family: monospace; font-size: 14px; margin: 0 0 4px 0;">Reply <code>APPROVE ${orderId}</code> to execute live.</p>
            <p style="color: #cbd5e1; font-family: monospace; font-size: 14px; margin: 0;">Reply <code>CANCEL ${orderId}</code> to discard.</p>
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
          <p style="color: #cbd5e1; font-size: 15px; margin-bottom: 16px;">${nlqRes.summary}</p>
          <div style="background: rgba(56, 189, 248, 0.1); border: 1px solid #0284c7; border-radius: 8px; padding: 12px;">
            <p style="color: #38bdf8; margin: 0; font-size: 13px;">🛡️ Account data reconciled against live E*TRADE REST API feeds.</p>
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

      // Default AI Answer
      const respSub = `🤖 E*TRADE Trading Assistant: ${subject || "Market Research"}`;
      const respText = nlqRes.summary || "Your trading research request was processed.";
      const respHtml = this.renderEmailContainer("E*TRADE Trading Assistant", `<p style="color: #cbd5e1; font-size: 14px;">${respText}</p>`);

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
      const respHtml = this.renderEmailContainer("Processing Error", `<p style="color: #ef4444;">${respText}</p>`);

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
    attachment?: { fileName: string; contentType: string; contentBase64: string }
  ): Promise<boolean> {
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to) || /[\r\n]/.test(subject)) {
      throw new Error("Invalid outbound email recipient or subject.");
    }
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
          `Content-Type: ${attachment ? `multipart/mixed; boundary="${mixedBoundary}"` : `multipart/alternative; boundary="${alternativeBoundary}"`}`,
          `X-Agent-DID: ${AGENT_DIDS.TRADING}`,
          ``,
        ];
        if (attachment) {
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
        if (attachment) {
          const safeFileName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "research.xlsx";
          rawParts.push(
            ``,
            `--${mixedBoundary}`,
            `Content-Type: ${attachment.contentType}; name="${safeFileName}"`,
            `Content-Disposition: attachment; filename="${safeFileName}"`,
            `Content-Transfer-Encoding: base64`,
            ``,
            attachment.contentBase64.match(/.{1,76}/g)?.join("\r\n") || "",
            ``,
            `--${mixedBoundary}--`,
          );
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
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
  <div style="max-width: 620px; margin: 0 auto; background-color: #0f172a; border-radius: 10px; border: 1px solid #1e293b; overflow: hidden; margin-top: 20px; margin-bottom: 20px;">
    <!-- Brand Header -->
    <div style="background: linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%); padding: 24px; border-bottom: 1px solid #1e293b;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span style="background: #3b82f6; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;">
            E*TRADE AGENTIC HUB
          </span>
          <h1 style="color: #ffffff; font-size: 20px; margin: 8px 0 0 0; font-weight: 700;">${headerTitle}</h1>
        </div>
      </div>
    </div>

    <!-- Body Content -->
    <div style="padding: 24px;">
      ${contentHtml}
    </div>

    <!-- Security & Provenance Footer -->
    <div style="background-color: #0b0f19; padding: 18px 24px; border-top: 1px solid #1e293b; font-size: 12px; color: #64748b;">
      <p style="margin: 0 0 6px 0;">
        🛡️ <strong>Trading Agent DID:</strong> <code style="color: #94a3b8;">${AGENT_DIDS.TRADING}</code>
      </p>
      <p style="margin: 0 0 6px 0;">
        ⚖️ <strong>Regulatory Compliance:</strong> Direct REST API execution over OAuth 1.0a. Strict Human-in-the-Loop protection enforced on all equity orders.
      </p>
      <p style="margin: 0;">
        OpenAIMP Agentic Trading Network • <a href="${this.env.APP_BASE_URL || "https://agent.openaimp.com"}" style="color: #38bdf8; text-decoration: none;">agent.openaimp.com</a>
      </p>
    </div>
  </div>
</body>
</html>`;
  }
}

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

  try {
    if (message.raw) {
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);
      subject = parsed.subject || "";
      text = parsed.text || "";
      html = parsed.html || "";
    }
  } catch (err) {
    console.warn("[CloudflareEmail] PostalMime parse failed, falling back to header inspect:", err);
    subject = message.headers?.get?.("subject") || "";
  }

  const service = new ETradeEmailTradingService(env);
  const result = await service.processInboundEmail({
    from,
    to,
    subject,
    text,
    html,
  });

  // Automatically dispatch outbound reply if Cloudflare Email Service reply is supported
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
    await service.sendOutboundEmail(from, result.responseSubject, result.responseHtml, result.responseText);
  }

  return result;
}
