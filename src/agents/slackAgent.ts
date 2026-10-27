/**
 * Cloudflare Slack Trading Agent — shell since Issue #1262 Phase 2.
 *
 * This class keeps the Agents SDK surface (the export pin in
 * tests/dead-agent-classes.test.ts, the /health endpoint, the #147
 * signature gate, and the /transaction-snap trigger) and the two
 * delegation helpers external code calls (sendPreTradeApprovalTicket,
 * dispatchTransactionSnap). It no longer parses Slack payloads
 * itself: slash commands, events, and interactions all delegate to
 * the single service, ETradeSlackTradingService — the duplicate
 * handleSlashCommand / handleInteraction implementations were
 * retired in #1262 Phase 2 (they ran NLQ under the DO instance id
 * with no principal resolution or tier gates, and double-dispatched
 * transaction snaps after approvals). The worker routes in
 * src/server.ts are the production ingress; this onRequest path is
 * the Agents SDK fallback (the class has no wrangler DO binding, so
 * it is unreachable in production — see src/orm/schema.ts:37).
 *
 * Issue #1960 (think-fleet): migrated from AIChatAgent to PortThink
 * (src/actors/thinkAdapter.ts). Chat-surface mapping, verified from
 * this file and its tests: the class defines no onChatMessage /
 * onChatResponse / onChatError / getModel / getSystemPrompt / getTools
 * and drives no AI chat turn — its "chat" is Slack webhook ingress
 * (commands, interactions, events) in onRequest below, delegating to
 * ETradeSlackTradingService, plus the two domain helpers. AIChatAgent's
 * WS chat-request path therefore only ever reached its default
 * onChatMessage, which throws; Think's native WS chat (runTurn with
 * Think defaults) replaces that throwing stub. The get-messages
 * onRequest intercept maps too: AIChatAgent returned its stored
 * transcript JSON, Think returns Response.json(this.messages) — and
 * this class writes to neither store, so both are empty in practice.
 * No port hooks object exists to keep (none were defined) and no
 * adapter turn is wired: inventing a model/tools/prompt would be new
 * behavior, not a preserved turn path. PortThink.portHooks stays
 * unset, so a direct Think turn uses Think defaults.
 */

import { PortThink } from "../actors/thinkAdapter";
import type {
  TransactionSnapData,
  PreTradeApprovalDraft,
} from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "./did";
import {
  ETradeSlackTradingService,
  resolvePrincipal,
  slackPrincipalLinkStoreFromEnv,
  verifySlackSignature,
} from "../trading";
import { gateSlackRequest } from "../security/webhookSecurity";
import { BrowserAgent } from "./browserAgent";

export class SlackAgent extends PortThink {
  private slackService?: ETradeSlackTradingService;
  private browserAgent?: BrowserAgent;

  sessionKey(): string {
    return this.ctx?.id ? this.ctx.id.toString() : "slack_agent_master";
  }

  private getSlackService(orm?: DatabaseORM): ETradeSlackTradingService {
    if (!this.slackService) {
      this.slackService = new ETradeSlackTradingService(
        this.env,
        orm,
        this.sessionKey() || "slack_agent_master"
      );
    } else if (orm && (this.slackService as any).orm !== orm) {
      (this.slackService as any).orm = orm;
    }
    return this.slackService;
  }

  private getBrowserAgent(): BrowserAgent {
    if (!this.browserAgent) {
      this.browserAgent = new BrowserAgent(this.ctx, this.env);
    }
    return this.browserAgent;
  }

  private getOrm(): DatabaseORM {
    return new DatabaseORM(this.ctx.storage.sql);
  }

  /**
   * Dispatches a Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
   * Before executing any trade, a message must be sent to Slack and approved.
   */
  async sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string; webhookUrl?: string } = {}
  ) {
    const service = this.getSlackService(this.getOrm());
    return service.sendPreTradeApprovalTicket(draft, options);
  }

  /**
   * Dispatches a transaction snapshot to Slack by coordinating with the Browser Agent
   */
  async dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { webhookUrl?: string; channel?: string; caption?: string } = {}
  ) {
    const browser = this.getBrowserAgent();
    return browser.sendTransactionSnapToSlack(tx, {
      webhookUrl: options.webhookUrl || this.env.SLACK_WEBHOOK_URL,
      channel: options.channel,
      caption: options.caption,
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-slack-signature, x-slack-request-timestamp",
        },
      });
    }

    // Health check
    if (path.endsWith("/health") || path === "/") {
      return Response.json({
        agent: "SlackAgent",
        status: "active",
        did: AGENT_DIDS.TRADING || "did:agent:openaimp:trading",
        capabilities: ["events_api", "slash_commands", "interactive_buttons", "browser_agent_snaps"],
        timestamp: new Date().toISOString(),
      });
    }

    // Issue #147: Slack signature verification is MANDATORY on the
    // Slack ingress paths — the same gate the worker routes in
    // src/server.ts apply (defense in depth: this agent is also
    // reachable via Agents SDK routing, and the gate must hold at
    // every layer a Slack payload can enter). Unconfigured → honest
    // 503 before any processing; configured → a missing or invalid
    // signature is rejected 401. Previously the check ran only when a
    // secret was configured AND the caller presented signature
    // headers, so unsigned requests were processed in every
    // configuration.
    const isSlackIngress =
      path.endsWith("/commands") || path.endsWith("/slash") ||
      path.endsWith("/interactions") ||
      path.endsWith("/events") || path.endsWith("/slack");
    if (request.method === "POST" && isSlackIngress) {
      const gate = await gateSlackRequest(request.clone(), this.env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
    } else if (request.method === "POST" && this.env.SLACK_SIGNING_SECRET) {
      // Non-Slack POSTs (e.g. the manual /transaction-snap trigger):
      // unchanged behaviour — when the caller presents Slack signature
      // headers, a bad signature is still rejected.
      const ts = request.headers.get("x-slack-request-timestamp");
      const sig = request.headers.get("x-slack-signature");
      if (ts && sig) {
        const rawBody = await request.clone().text();
        const isValid = await verifySlackSignature(this.env.SLACK_SIGNING_SECRET, ts, rawBody, sig);
        if (!isValid) {
          return new Response("Invalid Slack signature", { status: 401 });
        }
      }
    }

    // Issue #1262 Phase 2: every Slack ingress delegates to the
    // single service with a principal resolved from the payload's
    // team + user (the retired handlers ran without one). The
    // onRequest path carries no NLQ deps — it is the Agents SDK
    // fallback, unreachable in production (no wrangler binding);
    // the worker routes pass the full Phase 4 dep set. The service
    // still flags every NLQ call untrustedContent: true here.
    const slackLinks = slackPrincipalLinkStoreFromEnv(this.env);

    // 1. Slash Commands (/commands or /slack/commands)
    if (path.endsWith("/commands") || path.endsWith("/slash")) {
      const formData = await request.formData();
      const principal = await resolvePrincipal(
        this.env,
        {
          channel: "slack",
          channelUserId: typeof formData.get("user_id") === "string" ? (formData.get("user_id") as string) : "",
          channelScopeId: typeof formData.get("team_id") === "string" ? (formData.get("team_id") as string) : "",
          text: typeof formData.get("text") === "string" ? (formData.get("text") as string) : "",
        },
        { slackLinks }
      );
      const service = new ETradeSlackTradingService(this.env, this.getOrm(), this.sessionKey(), principal, slackLinks);
      return service.processSlackCommand(formData);
    }

    // 2. Interactive Components (/interactions or /slack/interactions)
    if (path.endsWith("/interactions")) {
      const rawBody = await request.text();
      const params = new URLSearchParams(rawBody);
      const payloadRaw = params.get("payload");
      if (!payloadRaw) return new Response("Missing payload parameter", { status: 400 });
      const payload = JSON.parse(payloadRaw);
      const principal = await resolvePrincipal(
        this.env,
        {
          channel: "slack",
          channelUserId: payload.user?.id ?? "",
          channelScopeId: payload.team?.id ?? "",
          text: "",
        },
        { slackLinks }
      );
      const service = new ETradeSlackTradingService(this.env, this.getOrm(), this.sessionKey(), principal, slackLinks);
      const result = await service.processSlackInteraction(payload);
      return Response.json(result);
    }

    // 3. Events API (/events or /slack/events)
    if (path.endsWith("/events") || path.endsWith("/slack")) {
      const body = (await request.json().catch(() => ({}))) as any;
      if (body.type === "url_verification") {
        return Response.json({ challenge: body.challenge });
      }

      const principal = await resolvePrincipal(
        this.env,
        {
          channel: "slack",
          channelUserId: body.event?.user ?? "",
          channelScopeId: body.team_id ?? "",
          text: "",
        },
        { slackLinks }
      );
      const service = new ETradeSlackTradingService(this.env, this.getOrm(), this.sessionKey(), principal, slackLinks);
      const eventResult = await service.processSlackEvent(body);
      return Response.json(eventResult);
    }

    // 4. Manual Transaction Snap Trigger (/transaction-snap)
    if (path.endsWith("/transaction-snap") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        const result = await this.dispatchTransactionSnap(tx, {
          webhookUrl: body.webhookUrl,
          channel: body.channel,
          caption: body.caption,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
  }
}
