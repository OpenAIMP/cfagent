/**
 * PR #5 (cont.) — Verifier: evidence check for agent outputs.
 *
 * Split from judge.ts: the router picks the model, the verifier
 * checks that the output is grounded in evidence. Used by the
 * orchestrator's supervise mode after each wave.
 */

export interface VerificationResult {
  /** Whether the output passes verification */
  pass: boolean;
  /** Confidence 0-1 */
  confidence: number;
  /** Issues found, if any */
  issues: string[];
}

export interface Evidence {
  /** The claim being verified */
  claim: string;
  /** Sources that should support it */
  sources: string[];
}

/**
 * Verify that an agent's output is supported by the provided evidence.
 * Heuristic checks (no LLM): non-empty, sources referenced, no
 * obvious hallucination markers.
 */
export function verifyOutput(output: string, evidence: Evidence[]): VerificationResult {
  const issues: string[] = [];

  if (!output || output.trim().length === 0) {
    return { pass: false, confidence: 1.0, issues: ["empty output"] };
  }

  // Check for hallucination markers
  const lower = output.toLowerCase();
  const markers = ["as an ai", "i don't have access", "i cannot verify"];
  for (const m of markers) {
    if (lower.includes(m)) {
      issues.push(`hallucination marker: "${m}"`);
    }
  }

  // Check that evidence sources are referenced (when evidence provided)
  if (evidence.length > 0) {
    const referenced = evidence.filter((e) =>
      e.sources.some((s) => output.includes(s.slice(0, 20)))
    );
    if (referenced.length === 0) {
      issues.push("no evidence sources referenced in output");
    }
  }

  const pass = issues.length === 0;
  return {
    pass,
    confidence: pass ? 0.9 : Math.max(0.1, 1 - issues.length * 0.3),
    issues,
  };
}

/**
 * LLM-based verification for high-stakes outputs.
 * Uses the judge model chain via runWithRouting.
 */
export async function verifyWithLLM(
  env: { AI: any },
  output: string,
  criteria: string
): Promise<VerificationResult> {
  const { runWithRouting } = await import("./router");
  const { result } = await runWithRouting("judge", async (model) => {
    const res = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content: "You verify agent outputs. Reply with ONLY JSON: {\"pass\": true|false, \"confidence\": 0-1, \"issues\": [...]}",
        },
        {
          role: "user",
          content: `Criteria: ${criteria}\n\nOutput to verify:\n${output.slice(0, 4000)}`,
        },
      ],
    });
    return res;
  });

  try {
    const text = (result as any).response ?? JSON.stringify(result);
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return {
      pass: !!parsed.pass,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    return { pass: false, confidence: 0.3, issues: ["unparseable verifier response"] };
  }
}
