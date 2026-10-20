import { getActiveLearnings, recordLearning } from "./learnings";
import { listStrategyReviews } from "./strategyReviews";

/**
 * Issue #705: scheduled reflection job — the agent reads its own track record.
 *
 * Runs weekly (or on demand). Reads outcomes + calibration + review decisions,
 * computes per-domain performance deltas, and writes reflection records as
 * learnings. Proposed behavioral adjustments go through HITL before taking
 * effect — the agent proposes, the human disposes.
 */

export interface ReflectionFinding {
  domain: string;
  observation: string;
  evidenceRefs: string[];
  confidence: number;
  proposedAdjustment: string;
}

export function runReflection(
  sql: any,
  now: Date = new Date()
): { findings: ReflectionFinding[]; learningsRecorded: number; skipped?: string } {
  // Weekly guard: only fire on Sunday, and not if a reflection learning
  // was already recorded this week.
  if (now.getUTCDay() !== 0) {
    return { findings: [], learningsRecorded: 0, skipped: "not Sunday" };
  }
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay());
  weekStart.setUTCHours(0, 0, 0, 0);
  try {
    const recent = getActiveLearnings(sql, "reflection_meta");
    if (recent.length > 0 && new Date(recent[0].createdAt) >= weekStart) {
      return { findings: [], learningsRecorded: 0, skipped: "already ran this week" };
    }
  } catch {}

  const findings: ReflectionFinding[] = [];

  // 1. Strategy review decisions → approval patterns.
  try {
    const reviews = listStrategyReviews(sql);
    const approved = reviews.filter((r) => r.decision === "approved");
    const rejected = reviews.filter((r) => r.decision === "rejected");
    if (approved.length + rejected.length >= 5) {
      const approvalRate = approved.length / (approved.length + rejected.length);
      // Group by label prefix (strategy family).
      const byFamily: Record<string, { a: number; r: number }> = {};
      for (const rev of reviews) {
        if (rev.decision !== "approved" && rev.decision !== "rejected") continue;
        const family = rev.label.split(" ")[0] || "unknown";
        byFamily[family] = byFamily[family] || { a: 0, r: 0 };
        if (rev.decision === "approved") byFamily[family].a++;
        else byFamily[family].r++;
      }
      for (const [family, counts] of Object.entries(byFamily)) {
        const total = counts.a + counts.r;
        if (total >= 3) {
          const rate = counts.a / total;
          if (rate >= 0.8) {
            findings.push({
              domain: "strategy_ranking",
              observation: `Strategy family "${family}" approved ${counts.a}/${total} times — consistently favored by human review.`,
              evidenceRefs: [`mas_strategy_reviews:${family}`],
              confidence: Math.min(0.9, 0.5 + total * 0.1),
              proposedAdjustment: `Boost "${family}" in LLM ranking priors.`,
            });
          } else if (rate <= 0.2) {
            findings.push({
              domain: "strategy_ranking",
              observation: `Strategy family "${family}" rejected ${counts.r}/${total} times — consistently disfavored by human review.`,
              evidenceRefs: [`mas_strategy_reviews:${family}`],
              confidence: Math.min(0.9, 0.5 + total * 0.1),
              proposedAdjustment: `Down-weight "${family}" in LLM ranking priors.`,
            });
          }
        }
      }
      if (approvalRate < 0.3 && approved.length + rejected.length >= 10) {
        findings.push({
          domain: "strategy_ranking",
          observation: `Overall approval rate ${(approvalRate * 100).toFixed(0)}% across ${approved.length + rejected.length} reviewed candidates — the quant pipeline may be misaligned with human judgment.`,
          evidenceRefs: ["mas_strategy_reviews:all"],
          confidence: 0.7,
          proposedAdjustment: "Review quant pipeline filters against rejected candidate characteristics.",
        });
      }
    }
  } catch {}

  // 2. Check for stale learnings that may need re-validation.
  try {
    const learnings = getActiveLearnings(sql);
    const now = Date.now();
    for (const l of learnings) {
      const ageDays = (now - new Date(l.createdAt).getTime()) / 86_400_000;
      if (ageDays > 90 && l.confidence < 0.6) {
        findings.push({
          domain: l.domain,
          observation: `Learning "${l.observation.slice(0, 60)}..." is ${Math.round(ageDays)} days old with low confidence (${l.confidence.toFixed(2)}) — may need re-validation or supersession.`,
          evidenceRefs: [`mas_learnings:${l.id}`],
          confidence: 0.6,
          proposedAdjustment: "Re-validate against recent outcomes or supersede.",
        });
      }
    }
  } catch {}

  // 3. Record findings as learnings (source: reflection).
  let learningsRecorded = 0;
  for (const f of findings) {
    try {
      recordLearning(sql, {
        domain: f.domain,
        observation: `${f.observation} Proposed: ${f.proposedAdjustment}`,
        evidenceRefs: f.evidenceRefs,
        confidence: f.confidence,
        source: "reflection",
      });
      learningsRecorded++;
    } catch {}
  }

  // 4. Record the run itself so next week's guard sees it.
  try {
    recordLearning(sql, {
      domain: "reflection_meta",
      observation: `Weekly reflection completed: ${findings.length} findings, ${learningsRecorded} learnings recorded.`,
      confidence: 1.0,
      source: "reflection",
    });
  } catch {}

  return { findings, learningsRecorded };
}
