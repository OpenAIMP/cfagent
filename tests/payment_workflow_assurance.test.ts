// @vitest-environment node
/**
 * Issue #2049: PaymentWorkflow assurance page runner.
 *
 * The page (src/client/PaymentWorkflowAssurance.tsx) runs the REAL
 * flow and gate behind fake seams. These tests pin the runner's 9
 * presets to their expected outcomes, so a future flow/gate change
 * that breaks the assurance page fails here instead of silently
 * changing what the page demonstrates.
 */
import { describe, expect, it } from "vitest";
import {
  PRESETS,
  runAssuranceScenario,
} from "../src/client/PaymentWorkflowAssurance";

describe("PaymentWorkflow assurance presets (#2049)", () => {
  it("has exactly the 9 flow scenarios", () => {
    expect(PRESETS).toHaveLength(9);
  });

  it("each preset produces its expected outcome", async () => {
    const expectedStatus: Record<string, string> = {
      "assurance-preset-1": "started",
      "assurance-preset-2": "started",
      "assurance-preset-3": "expired",
      "assurance-preset-4": "payment_required",
      "assurance-preset-5": "coverage_required",
      "assurance-preset-7": "screener_failed_credit_issued",
      "assurance-preset-8": "approval_rejected",
      "assurance-preset-9": "started",
    };
    for (const preset of PRESETS) {
      const result = await runAssuranceScenario(preset.config);
      if (preset.config.runRequestId === "assurance-preset-6") {
        expect(result.error).toMatch(/Tenant mismatch/);
        expect(result.outcome).toBeNull();
        continue;
      }
      expect(result.error).toBeNull();
      expect(result.outcome?.status).toBe(expectedStatus[preset.config.runRequestId]);
      if (preset.config.runRequestId === "assurance-preset-7") {
        expect(result.credited).toBe(true);
      }
      expect(result.trace.length).toBeGreaterThan(0);
    }
  });
});
