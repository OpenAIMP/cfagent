/**
 * Issue #162: LLM-powered QA failure investigation.
 *
 * When post-deploy QA fails, qa-smoke.mjs files a GitHub issue and then
 * calls the worker's /api/qa/investigate endpoint (wired in server.ts).
 * This module runs the investigation: it uses the model router
 * (cheap → primary → fallback) to produce a diagnosis, likely cause,
 * and proposed fix, which qa-smoke posts back as an issue comment for
 * human supervision.
 *
 * This is the "supervised fix" half of the self-healing loop: the AI
 * investigates and proposes, a human reviews and merges the fix PR.
 * (src/qa/self-healing.ts holds the CI-side issue-filing half.)
 */

import { requireGatewayPorts } from "../gateway/createGatewayPorts";
import { chainModels } from "../models/router";
import type { Env } from "../types";

export interface QAFailureInput {
  operation: string;
  errorClass: string;
  detail: string;
  runLink?: string;
}

export interface QAInvestigation {
  diagnosis: string;
  likelyCause: string;
  proposedFix: string;
  confidence: number;
  model: string;
}

const SYSTEM_PROMPT = `You are a site-reliability engineer investigating a post-deploy QA failure for a Cloudflare Workers application (TypeScript, Durable Objects, Workers AI).

Given the failed check name, error class, and detail, produce a concise investigation as JSON only:
{
  "diagnosis": "one-paragraph summary of what failed and its blast radius",
  "likelyCause": "most probable root cause, referencing the detail",
  "proposedFix": "concrete fix steps: files to change, what to change, how to verify",
  "confidence": 0.0-1.0
}

Be specific and actionable. If the detail is insufficient, say what log or signal would confirm the cause. Never invent file contents you have not seen.`;

/**
 * Investigate a QA failure with an LLM. Falls back across the model
 * chain on quota/overload errors; if all models fail, returns a
 * structured fallback so the caller can still post something useful.
 */
export async function investigateQAFailure(
  env: Env,
  failure: QAFailureInput
): Promise<QAInvestigation> {
  const prompt = [
    `Failed check: ${failure.operation}`,
    `Error class: ${failure.errorClass}`,
    ``,
    `Detail:`,
    failure.detail.slice(0, 4000),
    failure.runLink ? `\nRun: ${failure.runLink}` : ``,
  ].join("\n");

  try {
    // #1741: plan-chain failover now lives in the gateway port.
    const gateway = requireGatewayPorts(env);
    const { text, model } = await gateway.generate({
      models: chainModels("plan"),
      temperature: 0,
      system: SYSTEM_PROMPT,
      prompt,
      caller: "qa-investigate",
    });

    const parsed = parseJson(text);
    return {
      diagnosis: String(parsed.diagnosis || "Investigation completed; see detail."),
      likelyCause: String(parsed.likelyCause || "Unknown — see detail."),
      proposedFix: String(parsed.proposedFix || "Review the failure detail and run link."),
      confidence: typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      model,
    };
  } catch {
    return {
      diagnosis: `QA check "${failure.operation}" failed (${failure.errorClass}). Automated investigation was unavailable.`,
      likelyCause: "Unknown — investigation LLM unreachable.",
      proposedFix: `Review the failure detail manually and check the run link: ${failure.runLink || "n/a"}.`,
      confidence: 0,
      model: "none",
    };
  }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(value.slice(start, end + 1));
    }
    return JSON.parse(value);
  } catch {
    return {};
  }
}
