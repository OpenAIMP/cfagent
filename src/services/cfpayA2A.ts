/**
 * Issue #215: A2A client for cfpay's notification agents.
 *
 * Calls cfpay's Slack, Email, and Webhook agents via the A2A protocol
 * (JSON-RPC message/send) at the configured cfpay base URL.
 *
 * IMPORTANT LIMITATIONS:
 * 1. cfpay's A2A is CONVERSATIONAL — it accepts natural-language messages,
 *    not structured RPC. These methods send a structured instruction the
 *    agent is expected to parse. This is inherently less reliable than a
 *    typed API.
 * 2. Requires `CFPAY_URL` (default https://pay.openatimp.com) and
 *    `CFPAY_A2A_TOKEN` (bearer token) in env.
 * 3. The bearer token is never logged or returned.
 */

export interface CfpayA2AConfig {
  baseUrl: string;
  token: string;
}

export function getCfpayConfig(env: Record<string, unknown>): CfpayA2AConfig | null {
  const baseUrl = (env.CFPAY_URL as string) || "https://pay.openatimp.com";
  const token = env.CFPAY_A2A_TOKEN as string;
  if (!token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

interface A2AMessageResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Send a message to one of cfpay's A2A agents via JSON-RPC message/send.
 * Never throws — returns { ok: false, error } on failure.
 */
export async function sendCfpayA2AMessage(
  config: CfpayA2AConfig,
  agentPath: "/a2a/slack" | "/a2a/email" | "/a2a/webhooks",
  text: string
): Promise<A2AMessageResponse> {
  try {
    const res = await fetch(`${config.baseUrl}${agentPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text }],
          },
        },
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as any;
    // A2A returns a task; extract the agent's text reply.
    const result = data?.result;
    const replyText =
      result?.history?.[result.history.length - 1]?.parts
        ?.map((p: any) => p.text || "")
        .join("") || "";
    return { ok: true, text: replyText };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ask cfpay's Slack agent to post a message.
 * The instruction is structured for the conversational agent to parse.
 */
export async function cfpayPostToSlack(
  config: CfpayA2AConfig,
  channel: string,
  text: string
): Promise<A2AMessageResponse> {
  return sendCfpayA2AMessage(
    config,
    "/a2a/slack",
    `[AUTOMATED] Post the following message to Slack channel "${channel}":\n\n${text}`
  );
}

/**
 * Ask cfpay's Email agent to send an email.
 */
export async function cfpaySendEmail(
  config: CfpayA2AConfig,
  to: string,
  subject: string,
  bodyText: string
): Promise<A2AMessageResponse> {
  return sendCfpayA2AMessage(
    config,
    "/a2a/email",
    `[AUTOMATED] Send an email to "${to}" with subject "${subject}":\n\n${bodyText}`
  );
}

/**
 * Ask cfpay's Webhook agent to dispatch a webhook.
 */
export async function cfpayDispatchWebhook(
  config: CfpayA2AConfig,
  url: string,
  event: string,
  payload: Record<string, unknown>
): Promise<A2AMessageResponse> {
  return sendCfpayA2AMessage(
    config,
    "/a2a/webhooks",
    `[AUTOMATED] Dispatch webhook event "${event}" to ${url} with payload:\n\n${JSON.stringify(payload, null, 2)}`
  );
}
