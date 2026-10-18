/**
 * Issue #215: A2A client for cfpay's notification agents.
 *
 * Calls cfpay's Slack and Email agents via the A2A protocol using
 * STRUCTURED operations (not conversational). Each agent's handleA2AMessage
 * routes on a `data` part with an `operation` field — no LLM is involved.
 *
 * - Slack: `slack.post` with { text, channel? }
 * - Email: `email.send` with { to, subject, body }
 * - Webhook: cfpay has no outbound dispatch via A2A (only webhook.receive
 *   for inbound); use the local ETradeWebhookService instead.
 *
 * Requires `CFPAY_URL` (default https://pay.openaimp.com) and
 * `CFPAY_A2A_TOKEN` (bearer token) in env. The token is never logged.
 */

export interface CfpayA2AConfig {
  baseUrl: string;
  token: string;
}

export function getCfpayConfig(env: unknown): CfpayA2AConfig | null {
  const e = env as Record<string, unknown>;
  const baseUrl = (e.CFPAY_URL as string) || "https://pay.openaimp.com";
  const token = e.CFPAY_A2A_TOKEN as string;
  if (!token) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export interface A2AOperationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Invoke a structured operation on one of cfpay's A2A agents.
 * Sends a message with a `data` part: { operation, ...args }.
 * Never throws — returns { ok: false, error } on failure.
 */
export async function cfpayA2AOperation(
  config: CfpayA2AConfig,
  agentPath: "/a2a/slack" | "/a2a/email",
  operation: string,
  args: Record<string, unknown> = {}
): Promise<A2AOperationResult> {
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
            parts: [
              { kind: "text", text: `[automated] ${operation}` },
              { kind: "data", data: { operation, ...args } },
            ],
          },
        },
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as any;
    // The agent returns { text, data } via an artifact-update; the SDK
    // surfaces it in the task result. Extract the data part.
    const result = data?.result;
    const artifacts = result?.artifacts || [];
    for (const a of artifacts) {
      for (const p of a.parts || []) {
        if (p.kind === "data" && p.data && typeof p.data === "object") {
          const d = p.data as { ok?: boolean; error?: string };
          return { ok: d.ok !== false, data: p.data, error: d.error };
        }
      }
    }
    // Fallback: check history for a data part.
    const history = result?.history || [];
    for (const m of history) {
      for (const p of m.parts || []) {
        if (p.kind === "data" && p.data && typeof p.data === "object") {
          const d = p.data as { ok?: boolean; error?: string };
          return { ok: d.ok !== false, data: p.data, error: d.error };
        }
      }
    }
    return { ok: false, error: "no_data_part_in_response" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Post to Slack via cfpay. Channel is optional (falls back to webhook).
 */
export async function cfpayPostToSlack(
  config: CfpayA2AConfig,
  text: string,
  channel?: string
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/slack", "slack.post", {
    text,
    ...(channel ? { channel } : {}),
  });
}

/**
 * Send email via cfpay.
 */
export async function cfpaySendEmail(
  config: CfpayA2AConfig,
  to: string,
  subject: string,
  body: string
): Promise<A2AOperationResult> {
  return cfpayA2AOperation(config, "/a2a/email", "email.send", {
    to,
    subject,
    body,
  });
}
