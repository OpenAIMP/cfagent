/**
 * Issue #359-10: trading integrations routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the omnichannel trading channel block:
 * POST /trading/email/inbound,
 * POST /trading/slack/event, POST /trading/slack/interaction, POST /trading/slack/command,
 * POST /trading/browser/transaction-snap (also POST /browser/transaction-snap),
 * POST /trading/voice/turn, GET /trading/voice/greeting.
 * The seven blocks were contiguous in routeRequest (between the E*TRADE broker
 * routes block and the broker activity delegation), so this module exports ONE
 * handler invoked from routeRequest at the EXACT position the original blocks
 * occupied in the sequential matching sequence. It returns a Response when
 * one of its paths matches, or null when none does - matching order relative
 * to all other handlers is preserved by the call site.
 *
 * BOUNDARY DISCIPLINE (#290): ETradeEmailTradingService,
 * ETradeSlackTradingService and ETradeVoiceTradingService are imported ONLY
 * through the src/trading/index.ts boundary ("../trading"), exactly as the
 * inline code did. No direct imports of trading internals.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * TradingIntegrationsRouteContext parameter; there are no new globals and
 * no back-references into the class.
 */

import type { AgentContext } from "agents";
import { BrowserAgent } from "../browserAgent";
import { SlackAgent } from "../slackAgent";
import {
  ETradeEmailTradingService,
  ETradeSlackTradingService,
  ETradeVoiceTradingService,
} from "../../trading";
import {
  parseAuthenticationResults,
  resolvePrincipal,
  slackPrincipalLinkStoreFromEnv,
  type ChannelPrincipal,
} from "../../trading";
import type { TransactionSnapData } from "../../types";
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { AgentName } from "../../types";
import type { NLQSchedulingPort } from "../nlq";

/** The subset of OrchestratorAgent surface the trading-integrations handlers need. */
export interface TradingIntegrationsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Audit writer (owner: OrchestratorAgent - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * forwarded to the SlackAgent / BrowserAgent constructors. */
  agentCtx: AgentContext;
  /** NLQ scheduling port (owner: OrchestratorAgent - was `this.nlqSchedulingPort()`). */
  nlqSchedulingPort(): NLQSchedulingPort;
}

/**
 * Handles the omnichannel trading integration routes (email / slack /
 * browser / voice). Returns a Response on match, null when no integration
 * path matches (the orchestrator then continues its sequential matching).
 */
export async function handleTradingIntegrationsRoutes(
  request: Request,
  _url: URL,
  path: string,
  sessionId: string,
  ctx: TradingIntegrationsRouteContext
): Promise<Response | null> {
  // Omnichannel Trading Channel: Inbound Email Trading Agent
  if (path.endsWith("/trading/email/inbound") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: identity is the RESOLVED channel principal,
      // never a fallback literal. Two entry shapes reach this route:
      // (a) the session-authenticated simulator (server.ts requireAuth
      // forwards to the caller's OWN instance with x-user-login set to
      // the verified session login): the session IS the principal, at
      // trade tier. (b) the Cloudflare email forward, which asserts no
      // identity header: resolve from the payload — sender →
      // CHANNEL_EMAIL_PRINCIPALS, gated by Authentication-Results.
      // Unmapped (null) still constructs the service so the sender gets
      // an explicit refusal reply; it runs nothing.
      const headerLogin = request.headers.get("x-user-login");
      let principal: ChannelPrincipal | null;
      if (headerLogin) {
        principal = {
          userLogin: headerLogin,
          authorizerDid: `did:user:email:${typeof body.from === "string" && body.from ? body.from : headerLogin}`,
          tier: "trade",
        };
      } else {
        principal = await resolvePrincipal(ctx.env, {
          channel: "email",
          channelUserId: typeof body.from === "string" ? body.from : "",
          text: `${body.subject || ""}\n${body.text || body.html || ""}`,
          authProof: parseAuthenticationResults(
            typeof body.authenticationResults === "string" ? body.authenticationResults : undefined
          ),
        });
      }
      const emailService = new ETradeEmailTradingService(ctx.env, ctx.getOrm(), sessionId, principal);
      const result = await emailService.processInboundEmail(body);
      ctx.audit("trading.email_processed", "trading", { actionType: result.actionType, from: result.from, orderId: result.orderId });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process inbound email" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Event Handler
  if (path.endsWith("/trading/slack/event") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: identity is the RESOLVED channel principal
      // (connect-code link store: team_id + user_id → login). The
      // session-authenticated test simulator is the only forwarder that
      // sets x-user-login (to the verified session login, routed to the
      // caller's own instance): a session principal at trade tier. The
      // public webhook forward asserts no identity header. The
      // url_verification handshake carries no user and is answered by
      // the service directly. Unlinked (null) still constructs the
      // service so the user gets an explicit refusal — and can run the
      // `link` DM command — but nothing executes.
      const headerLogin = request.headers.get("x-user-login");
      const slackLinks = slackPrincipalLinkStoreFromEnv(ctx.env);
      let principal: ChannelPrincipal | null | undefined;
      if (body.type === "url_verification") {
        principal = undefined;
      } else if (headerLogin) {
        principal = {
          userLogin: headerLogin,
          authorizerDid: `did:user:slack:${body.event?.user || "unknown"}`,
          tier: "trade",
        };
      } else {
        principal = await resolvePrincipal(
          ctx.env,
          {
            channel: "slack",
            channelUserId: typeof body.event?.user === "string" ? body.event.user : "",
            channelScopeId: typeof body.team_id === "string" ? body.team_id : "",
            text: typeof body.event?.text === "string" ? body.event.text : "",
          },
          { slackLinks }
        );
      }
      const slackService = new ETradeSlackTradingService(ctx.env, ctx.getOrm(), sessionId, principal, slackLinks);
      const result = await slackService.processSlackEvent(body);
      ctx.audit("trading.slack_event", "trading", { actionType: result.actionType, handled: result.handled });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack event" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Interactive Component Actions (Button Approvals)
  if (path.endsWith("/trading/slack/interaction") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: same link-store resolution as events — a
      // button click is an approval attempt and is gated on the
      // clicker's own linked principal inside the service.
      const slackLinks = slackPrincipalLinkStoreFromEnv(ctx.env);
      const principal = await resolvePrincipal(
        ctx.env,
        {
          channel: "slack",
          channelUserId: typeof body.user?.id === "string" ? body.user.id : "",
          channelScopeId: typeof body.team?.id === "string" ? body.team.id : typeof body.team_id === "string" ? body.team_id : "",
          text: "",
        },
        { slackLinks }
      );
      const slackService = new ETradeSlackTradingService(ctx.env, ctx.getOrm(), sessionId, principal, slackLinks);
      const result = await slackService.processSlackInteraction(body);
      ctx.audit("trading.slack_interaction", "trading", { actionId: result.actionId, orderId: result.orderId, status: result.status });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack interaction" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Slack Slash Commands (/trade, /quote, /screen, /options, /snap)
  if (path.endsWith("/trading/slack/command") && request.method === "POST") {
    try {
      const formData = await request.formData();
      const slackAgent = new SlackAgent(ctx.agentCtx, ctx.env);
      return slackAgent.handleSlashCommand(formData);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process slash command" }, { status: 500 });
    }
  }

  // Cloudflare Browser Agent: Transaction Snapshot Dispatch via Webhook
  if ((path.endsWith("/trading/browser/transaction-snap") || path.endsWith("/browser/transaction-snap")) && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const tx: TransactionSnapData = body.transaction || body;
      const browserAgent = new BrowserAgent(ctx.agentCtx, ctx.env);
      const result = await browserAgent.sendTransactionSnapToSlack(tx, {
        webhookUrl: body.webhookUrl || ctx.env.SLACK_WEBHOOK_URL,
        channel: body.channel,
        caption: body.caption,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate transaction snap" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Voice Trading Turn
  if (path.endsWith("/trading/voice/turn") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // Issue #1262 Phase 1: voice adopts the ChannelIntake contract
      // type only — the principal is the session login (every entry to
      // this route is session-authenticated in server.ts), tier "trade",
      // behaviour unchanged.
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const principal =
        (await resolvePrincipal(ctx.env, { channel: "voice", channelUserId: userLogin, text: "" })) ?? undefined;
      const voiceService = new ETradeVoiceTradingService(ctx.env, ctx.getOrm(), userLogin, ctx.nlqSchedulingPort(), principal);
      const result = await voiceService.processVoiceTurn({
        ...body,
        sessionId: userLogin,
        userLogin,
      });
      ctx.audit("trading.voice_turn", "trading", { actionType: result.actionType, orderId: result.orderId, success: result.success });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to process voice turn" }, { status: 500 });
    }
  }

  // Omnichannel Trading Channel: Voice Trading Welcome Greeting
  if (path.endsWith("/trading/voice/greeting") && request.method === "GET") {
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const principal =
      (await resolvePrincipal(ctx.env, { channel: "voice", channelUserId: userLogin, text: "" })) ?? undefined;
    const voiceService = new ETradeVoiceTradingService(ctx.env, ctx.getOrm(), userLogin, undefined, principal);
    return Response.json(voiceService.getWelcomeGreeting());
  }

  return null;
}
