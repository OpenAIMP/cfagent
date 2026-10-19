import {
  cfpayPostFileToSlack,
  cfpayPostToSlack,
  getCfpayConfig,
} from "./cfpayA2A";

export interface ScreenerSlackPdf {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  comment: string;
}

export interface ScreenerSlackDelivery {
  text: string;
  channel?: string;
  pdf?: ScreenerSlackPdf;
}

/** Deliver a screener result through the Slack A2A agent, attaching its PDF when available. */
export async function deliverScreenerToSlackA2A(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const config = getCfpayConfig(env);
  if (!config) return { ok: false, error: "CFPAY_A2A_TOKEN is not configured" };

  const e = env as Record<string, unknown>;
  const channel = delivery.channel ||
    (e.SCREENER_SLACK_CHANNEL as string | undefined) ||
    (e.SLACK_CHANNEL as string | undefined);

  if (delivery.pdf) {
    if (!channel) return { ok: false, error: "Slack channel is required to upload a PDF" };
    const bytes = delivery.pdf.bytes;
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const result = await cfpayPostFileToSlack(config, {
      channel,
      filename: delivery.pdf.fileName,
      contentB64: btoa(binary),
      title: delivery.pdf.title,
      initial_comment: delivery.pdf.comment,
    });
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  }

  const result = await cfpayPostToSlack(config, delivery.text, channel);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}
