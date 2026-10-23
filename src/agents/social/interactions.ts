/**
 * #1077 Phase 5b slice 3 — Slack interaction handling for social approvals.
 *
 * The social half of POST /slack/interactions. The Worker route
 * already runs the #147 gate (gateSlackRequest: missing signing secret
 * → 503, bad signature → 401) before this module ever sees a payload,
 * so this handler trusts the gate exactly like the trading handler
 * does — and the trust model is the same: any workspace member who
 * can click the button can approve, just like the trading HITL cards.
 * The approver is recorded as slack:<userId> (stable; usernames can
 * change), following the trading authorizerDid convention.
 *
 * Routing contract (server.ts enforces it before calling here):
 * - action_id social_approve / social_reject with a value of
 *   date|channel|draftId (see delivery.approvalCardValue).
 * - Any other action_id is NOT handled here: parseSocialAction
 *   returns kind "other" and the caller falls through to trading.
 *
 * Fail-closed rules, all returning a 200 replacement message (Slack
 * already accepted the interaction; the message must say what
 * happened, never silently do nothing):
 * - No pending approval for the date+channel → refused (already
 *   decided, or never requested).
 * - Pending draftId differs from the card's value → stale card,
 *   refused (a rebuilt draft needs its own card).
 * - Approve → approveAndPublish (prompt publish through the existing
 *   path); a publish failure still counts as approved, and the
 *   message says so with the reason — catch-up retries it.
 * - Reject → rejectDraft; nothing publishes.
 * - Replacement blocks follow the trading convention (header with the
 *   outcome, fields, draft text as plain_text, outcome context).
 */

import { parseApprovalCardValue } from "./delivery";
import { approveAndPublish, rejectSocialDraft, type ApprovePublishDeps } from "./approvalActions";

export interface SlackInteractionPayload {
  actions?: { action_id?: string; value?: string }[];
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  [key: string]: unknown;
}

export type ParsedSocialAction =
  | {
      kind: "social";
      action: "approve" | "reject";
      date: string;
      channel: string;
      draftId: string;
      userId: string;
    }
  | { kind: "other" }
  | { kind: "error"; error: string };

export function parseSocialAction(payload: SlackInteractionPayload): ParsedSocialAction {
  const action = payload.actions?.[0];
  if (!action) return { kind: "error", error: "no action in payload" };
  if (action.action_id !== "social_approve" && action.action_id !== "social_reject") {
    return { kind: "other" };
  }
  const parsed = parseApprovalCardValue(action.value);
  if (!parsed) return { kind: "error", error: "malformed approval card value" };
  return {
    kind: "social",
    action: action.action_id === "social_approve" ? "approve" : "reject",
    ...parsed,
    userId: payload.user?.id ?? "unknown",
  };
}

export interface SocialInteractionResult {
  handled: boolean;
  message: string;
  blocks: unknown[];
}

function outcomeBlocks(input: {
  headline: string;
  date: string;
  channel: string;
  approver: string;
  text: string;
  outcome: string;
}): unknown[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: input.headline, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Channel:*\n${input.channel}` },
        { type: "mrkdwn", text: `*Date:*\n${input.date}` },
        { type: "mrkdwn", text: `*Approver:*\n<@${input.approver}>` },
      ],
    },
    {
      type: "section",
      text: { type: "plain_text", text: input.text, emoji: false },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: input.outcome }],
    },
  ];
}

export async function handleSocialSlackInteraction(
  deps: ApprovePublishDeps & { payload: SlackInteractionPayload },
): Promise<SocialInteractionResult> {
  const parsed = parseSocialAction(deps.payload);
  if (parsed.kind === "other") {
    return { handled: false, message: "", blocks: [] };
  }
  if (parsed.kind === "error") {
    return {
      handled: true,
      message: `Social approval error: ${parsed.error}.`,
      blocks: [
        {
          type: "section",
          text: { type: "plain_text", text: `Social approval error: ${parsed.error}.` },
        },
      ],
    };
  }
  const { date, channel, draftId, userId } = parsed;
  const pending = (await deps.approvals.listPending(date)).find((p) => p.channel === channel);
  if (!pending) {
    return {
      handled: true,
      message: `No pending approval for ${channel} on ${date} — already decided or never requested.`,
      blocks: outcomeBlocks({
        headline: "No pending approval",
        date,
        channel,
        approver: userId,
        text: "This approval is no longer pending.",
        outcome: "No action taken.",
      }),
    };
  }
  if (pending.draftId !== draftId) {
    return {
      handled: true,
      message: `Stale approval card for ${channel} on ${date} — a newer draft exists; use its card.`,
      blocks: outcomeBlocks({
        headline: "Stale approval card",
        date,
        channel,
        approver: userId,
        text: "This card refers to an older draft.",
        outcome: "No action taken. A newer draft has its own approval card.",
      }),
    };
  }
  if (parsed.action === "reject") {
    const rejected = await rejectSocialDraft({
      store: deps.store,
      approvals: deps.approvals,
      date,
      channel,
    });
    if (!rejected.ok) {
      return {
        handled: true,
        message: `Social approval error: ${rejected.error}.`,
        blocks: outcomeBlocks({
          headline: "Approval error",
          date,
          channel,
          approver: userId,
          text: "The rejection could not be recorded.",
          outcome: rejected.error,
        }),
      };
    }
    return {
      handled: true,
      message: `REJECTED: ${channel} post for ${date} will not publish.`,
      blocks: outcomeBlocks({
        headline: `❌ REJECTED: ${channel} post`,
        date,
        channel,
        approver: userId,
        text: rejected.draft.text,
        outcome: "Rejected. The draft record is retained and will not publish.",
      }),
    };
  }
  const approved = await approveAndPublish({
    ...deps,
    date,
    channel,
    approver: `slack:${userId}`,
  });
  if (!approved.ok) {
    return {
      handled: true,
      message: `Social approval error: ${approved.error}.`,
      blocks: outcomeBlocks({
        headline: "Approval error",
        date,
        channel,
        approver: userId,
        text: "The approval could not be recorded.",
        outcome: approved.error,
      }),
    };
  }
  const result = approved.channelResult;
  // #1171: "posted" means really-posted, including in user-facing
  // copy. A dry-run publish reports its synthetic dry-run: id, so
  // the message says dry-run-posted rather than claiming a post
  // went live. The prefix check is display-only, never a gate:
  // only DryRunPublisher mints dry-run: ids.
  const isDryRun = result?.platformPostId?.startsWith("dry-run:");
  const publishOutcome =
    result?.outcome === "posted"
      ? isDryRun
        ? `Dry-run recorded (draft now dry-run-posted, ${result.platformPostId}).`
        : `Published (draft now posted, ${result.platformPostId ?? "no post id"}).`
      : result?.outcome === "error"
        ? `Approved, but publish failed: ${result.reason ?? "unknown error"}. Catch-up will retry it.`
        : "Approved; publish outcome unknown — check the ledger.";
  return {
    handled: true,
    message: `APPROVED: ${channel} post for ${date} — ${publishOutcome}`,
    blocks: outcomeBlocks({
      headline: `✅ APPROVED: ${channel} post`,
      date,
      channel,
      approver: userId,
      text: approved.draft.text,
      outcome: publishOutcome,
    }),
  };
}
