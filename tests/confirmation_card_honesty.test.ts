/**
 * Issue #141 (follow-up to #123 / audit finding F16): the Chat HITL
 * CONFIRMATION card stated an execution outcome for what is only a
 * human AUTHORIZATION decision:
 *
 *  - the status pill read "EXECUTED" when a draft was approved and
 *    "CANCELLED" when it was rejected — approving a task draft merely
 *    queues it ("scheduled"), and a rejected draft was declined, not
 *    cancelled after the fact;
 *  - the binary `isApproved ? … : …` derivation rendered every result
 *    without an explicit approval signal — errors, partial results —
 *    as REJECTED/CANCELLED;
 *  - the fallback detail "Draft confirmed by human reviewer." was
 *    shown even for rejections;
 *  - upstream, the confirmDraft producer announced a REJECTED task as
 *    "Task confirmed and added to scheduled execution queue." in the
 *    auditNotice the card displays verbatim, and audited it as
 *    "task.confirmed".
 *
 * The card now derives from confirmationCardPresentation: the pill
 * states the authorization outcome in the codebase's decision
 * vocabulary (APPROVED / REJECTED), an unrecognizable result renders
 * STATUS UNAVAILABLE, and execution wording lives only on the
 * execution card (#123). Producer payloads are pinned end-to-end via
 * createMAS with a stub SQL store.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { confirmationCardPresentation } from "../src/client/confirmationCard";
import { createMAS } from "../src/agents/mas";

// Source pins read via cwd-relative paths (vitest runs at the repo
// root) — the pattern used by tests/claims_batch_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

// ===========================================================================
// confirmationCardPresentation — authorization wording, never execution
// ===========================================================================

describe("#141 — confirmationCardPresentation", () => {
  it("approved task (decision approved, status scheduled): APPROVED — never EXECUTED for a merely queued draft", () => {
    const p = confirmationCardPresentation({
      draftId: "task_1",
      status: "scheduled",
      decision: "approved",
      auditNotice: "Task confirmed and added to scheduled execution queue.",
    });
    expect(p.decision).toBe("approved");
    expect(p.verdict).toBe("APPROVED");
    expect(p.pillLabel).toBe("APPROVED");
    expect(p.pillClass).toBe("success");
    expect(p.pillLabel).not.toBe("EXECUTED");
    // The fallback detail also refuses the execution claim: queued ≠ run.
    expect(p.detailFallback).toContain("queued for scheduled execution");
  });

  it("approved payment (decision approved, status completed, gateway artefacts present): still APPROVED — dispatch facts come from the result's own text, not the pill", () => {
    const p = confirmationCardPresentation({
      draftId: "pay_1",
      status: "completed",
      decision: "approved",
      gatewayRef: "cs_test_123",
      checkoutUrl: "https://checkout.example/pay_1",
    });
    expect(p.decision).toBe("approved");
    expect(p.pillLabel).toBe("APPROVED");
    expect(p.pillLabel).not.toBe("EXECUTED");
    expect(p.detailFallback).toBe("Draft approved by human reviewer.");
  });

  it("status-only signals infer the decision (authorized / scheduled ⇒ approved)", () => {
    expect(confirmationCardPresentation({ draftId: "ord_1", status: "authorized" }).pillLabel).toBe("APPROVED");
    expect(confirmationCardPresentation({ draftId: "task_2", status: "scheduled" }).decision).toBe("approved");
  });

  it("rejected (decision rejected): REJECTED — never CANCELLED, and the fallback stops claiming confirmation", () => {
    const p = confirmationCardPresentation({
      draftId: "pay_2",
      status: "rejected",
      decision: "rejected",
    });
    expect(p.decision).toBe("rejected");
    expect(p.verdict).toBe("REJECTED");
    expect(p.pillLabel).toBe("REJECTED");
    expect(p.pillClass).toBe("priority-urgent");
    expect(p.pillLabel).not.toBe("CANCELLED");
    expect(p.detailFallback).toBe("Draft rejected by human reviewer.");
  });

  it("rejected via status alone (no decision field) renders REJECTED", () => {
    const p = confirmationCardPresentation({ draftId: "task_3", status: "rejected" });
    expect(p.decision).toBe("rejected");
    expect(p.pillLabel).toBe("REJECTED");
  });

  it("pre-decision / unrecognizable results render STATUS UNAVAILABLE — the old binary guessed REJECTED/CANCELLED", () => {
    for (const data of [{}, { draftId: "pay_3" }, { draftId: "pay_4", error: "draft not found" }]) {
      const p = confirmationCardPresentation(data);
      expect(p.decision).toBe("unknown");
      expect(p.verdict).toBe("STATUS UNAVAILABLE");
      expect(p.pillLabel).toBe("STATUS UNAVAILABLE");
      expect(p.pillClass).toBe("info");
      expect(p.detailFallback).toBe("Authorization status unavailable for this draft.");
    }
  });

  it("the explicit human decision is authoritative over a contradictory status", () => {
    expect(
      confirmationCardPresentation({ decision: "approved", status: "rejected" }).decision
    ).toBe("approved");
    expect(
      confirmationCardPresentation({ decision: "rejected", status: "scheduled" }).decision
    ).toBe("rejected");
  });

  it("source pins: the Chat card derives from the helper and the execution-claim pill is gone", () => {
    const chat = src("client/chat/ToolResultView.tsx");
    expect(chat).toContain("confirmationCardPresentation(data)");
    expect(chat).not.toContain('isApproved ? "EXECUTED" : "CANCELLED"');
    expect(chat).not.toContain('"Draft confirmed by human reviewer."');
  });
});

// ===========================================================================
// confirmDraft producer — a rejected task must not announce itself as
// confirmed/queued, in the auditNotice the card displays or the audit log
// ===========================================================================

describe("#141 — confirmDraft task payloads state the actual decision", () => {
  function makeMAS() {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tools = createMAS({
      env: {} as any,
      sessionId: "sess_141",
      requestId: "req_141",
      sql: { exec: () => [] as unknown[] },
      audit: (type: string, _agent: any, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
    });
    return { tools, events };
  }

  it("approved task: queued wording + task.confirmed audit", async () => {
    const { tools, events } = makeMAS();
    const res: any = await (tools.confirmDraft as any).execute({
      draftId: "task_approve",
      decision: "approved",
    });
    expect(res.status).toBe("scheduled");
    expect(res.decision).toBe("approved");
    expect(res.auditNotice).toContain("added to scheduled execution queue");
    expect(events.map((e) => e.type)).toContain("task.confirmed");
  });

  it("rejected task: the notice states the rejection (never 'confirmed/queued') and the audit is task.rejected", async () => {
    const { tools, events } = makeMAS();
    const res: any = await (tools.confirmDraft as any).execute({
      draftId: "task_reject",
      decision: "rejected",
    });
    expect(res.status).toBe("rejected");
    expect(res.decision).toBe("rejected");
    expect(res.auditNotice).toBe("Task draft rejected by human reviewer.");
    expect(res.auditNotice).not.toContain("scheduled execution queue");
    expect(events.map((e) => e.type)).toContain("task.rejected");
    expect(events.map((e) => e.type)).not.toContain("task.confirmed");
  });

  it("the card renders the rejected-task payload as REJECTED end to end", async () => {
    const { tools } = makeMAS();
    const res: any = await (tools.confirmDraft as any).execute({
      draftId: "task_reject_e2e",
      decision: "rejected",
    });
    const p = confirmationCardPresentation(res);
    expect(p.pillLabel).toBe("REJECTED");
    // …and the detail line the user actually sees is the producer's
    // notice, which no longer contradicts the pill.
    expect(res.auditNotice).not.toContain("confirmed");
  });
});
