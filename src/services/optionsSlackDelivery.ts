import type { Env } from "../types";

/**
 * Issue #358 — deliver a manual options scan to Slack over A2A.
 *
 * Mirrors the scheduled path (#331/#350) so manual and scheduled scans
 * produce the same Slack output: a text summary via `slack.post`, then the
 * PDF report via `slack.postFile`, both through cfpay's Slack agent.
 *
 * Kept out of the route handler so the behaviour is testable without a
 * Worker, and so the "never post unless asked" rule lives in one place:
 * callers only invoke this when the request explicitly opted in.
 */

export interface OptionsSlackDeliveryResult {
  /** The text summary reached Slack. */
  text: boolean;
  /** The PDF report reached Slack. */
  pdf: boolean;
  /** First failure encountered, for reporting back to the caller. */
  error?: string;
}

export interface OptionsSlackDeliveryInput {
  /** `result.toSlack()` from the unified options service. */
  slackPayload: unknown;
  /** `result.data` — the scan result the PDF generator expects. */
  scanData: unknown;
  /** Explicit channel; falls back to SCREENER_SLACK_CHANNEL. */
  slackChannel?: string;
  /** Thesis label for the file title (defaults to "bullish"). */
  thesis?: string;
}

function slackText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  const withText = payload as { text?: unknown } | null;
  if (withText && typeof withText.text === "string" && withText.text) return withText.text;
  return JSON.stringify(payload);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function deliverOptionsScanToSlack(
  env: Env,
  input: OptionsSlackDeliveryInput
): Promise<OptionsSlackDeliveryResult> {
  const result: OptionsSlackDeliveryResult = { text: false, pdf: false };

  try {
    const { getCfpayConfig, cfpayPostToSlack, cfpayPostFileToSlack } = await import("./cfpayA2A");
    const cfpay = getCfpayConfig(env);
    if (!cfpay) {
      result.error = "cfpay A2A is not configured; Slack delivery was skipped.";
      return result;
    }

    const channel = String(input.slackChannel || (env as unknown as { SCREENER_SLACK_CHANNEL?: string }).SCREENER_SLACK_CHANNEL || "");

    const textRes = await cfpayPostToSlack(cfpay, slackText(input.slackPayload), channel || undefined);
    result.text = textRes.ok;
    if (!textRes.ok) result.error = textRes.error;

    try {
      const { generateOptionsPdf, optionsPdfFileName } = await import("../trading");
      const pdfBytes = await generateOptionsPdf(input.scanData as Parameters<typeof generateOptionsPdf>[0]);
      const fileRes = await cfpayPostFileToSlack(cfpay, {
        channel,
        filename: optionsPdfFileName(input.scanData as Parameters<typeof optionsPdfFileName>[0]),
        contentB64: toBase64(pdfBytes),
        title: `Options scan — ${input.thesis || "bullish"}`,
        initial_comment: `Manual options scan — ${(input.scanData as { matchedCount?: number } | null)?.matchedCount ?? 0} contracts matched`,
      });
      result.pdf = fileRes.ok;
      if (!fileRes.ok && !result.error) result.error = fileRes.error;
    } catch (pdfErr) {
      if (!result.error) {
        result.error = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}
