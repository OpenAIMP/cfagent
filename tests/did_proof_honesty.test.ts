/**
 * Issue #151 (follow-up to #141 / #122): two honesty defects in the
 * Chat payments / trading surfaces:
 *
 *  - The DID Proof modal rendered a HARD-CODED signature
 *    ("0x4b78a9c2…") whenever the transaction record carried no
 *    proofSignature — a fabricated cryptographic proof presented as
 *    the transaction's own, the same family as the fabricated proofs
 *    deleted in #122. The modal now renders the real signature
 *    verbatim via didProofSignatureDisplay, or the honest absence
 *    message when there is none. The literal is source-pinned across
 *    the whole src/client tree so it cannot be reintroduced.
 *
 *  - The order-preview card derived its status pill from a binary
 *    `status === "executed" ? "EXECUTED" : "Awaiting Approval"`, so a
 *    REJECTED draft wore a stale "Awaiting Approval" label (its action
 *    buttons already hid for rejected drafts — only the label lied).
 *    The pill now derives from the draft's actual status via
 *    orderPreviewCardPresentation. The same card also presented a
 *    hard-coded "ord_preview" placeholder as a reserved E*TRADE Order
 *    ID when the result carried none; the ID segment now renders only
 *    when a real order ID exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { didProofSignatureDisplay, NO_PROOF_SIGNATURE_MESSAGE } from "../src/client/didProofCard";
import { orderPreviewCardPresentation } from "../src/client/orderPreviewCard";

// Source pins read via cwd-relative paths (vitest runs at the repo
// root) — the pattern used by tests/confirmation_card_honesty.test.ts.
const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// The fabricated signature the modal used to fall back to. Written
// here in fragments so this test file itself never contains the
// contiguous literal it pins against.
const FABRICATED_SIGNATURE = ["0x4b78a9c2", "e1f40d89", "e5a1b3c7", "d6e8f2a4"].join("");

// ===========================================================================
// didProofSignatureDisplay — the real signature, or an honest absence
// ===========================================================================

describe("#151 — didProofSignatureDisplay", () => {
  it("renders a real proof signature verbatim when present", () => {
    expect(didProofSignatureDisplay("sig_0xdeadbeefcafe")).toBe("sig_0xdeadbeefcafe");
    expect(didProofSignatureDisplay("0xabc123")).toBe("0xabc123");
  });

  it("renders the honest absence message when the record carries no signature", () => {
    expect(didProofSignatureDisplay(undefined)).toBe(NO_PROOF_SIGNATURE_MESSAGE);
    expect(didProofSignatureDisplay(null)).toBe(NO_PROOF_SIGNATURE_MESSAGE);
    expect(didProofSignatureDisplay("")).toBe(NO_PROOF_SIGNATURE_MESSAGE);
    expect(didProofSignatureDisplay("   ")).toBe(NO_PROOF_SIGNATURE_MESSAGE);
    expect(didProofSignatureDisplay(0)).toBe(NO_PROOF_SIGNATURE_MESSAGE);
    expect(didProofSignatureDisplay({})).toBe(NO_PROOF_SIGNATURE_MESSAGE);
  });

  it("the absence message is plainly not a signature (no plausible substitute)", () => {
    expect(NO_PROOF_SIGNATURE_MESSAGE).toBe("No proof signature available");
    expect(NO_PROOF_SIGNATURE_MESSAGE).not.toMatch(/0x[0-9a-f]{8,}/i);
    expect(didProofSignatureDisplay(undefined)).not.toBe(FABRICATED_SIGNATURE);
  });
});

// ===========================================================================
// orderPreviewCardPresentation — the pill states the draft's actual state
// ===========================================================================

describe("#151 — orderPreviewCardPresentation", () => {
  it("genuinely pending drafts read Awaiting Approval", () => {
    expect(orderPreviewCardPresentation("previewed")).toEqual({
      pillLabel: "Awaiting Approval",
      pillClass: "warning",
    });
    expect(orderPreviewCardPresentation("awaiting_confirmation").pillLabel).toBe("Awaiting Approval");
    expect(orderPreviewCardPresentation("draft").pillLabel).toBe("Awaiting Approval");
    // No status reported: a fresh preview — pending, not a terminal claim.
    expect(orderPreviewCardPresentation(undefined).pillLabel).toBe("Awaiting Approval");
    expect(orderPreviewCardPresentation("").pillLabel).toBe("Awaiting Approval");
  });

  it("a REJECTED draft reads REJECTED — never a stale Awaiting Approval", () => {
    const p = orderPreviewCardPresentation("rejected");
    expect(p.pillLabel).toBe("REJECTED");
    expect(p.pillLabel).not.toBe("Awaiting Approval");
    expect(p.pillClass).toBe("priority-urgent");
    expect(orderPreviewCardPresentation(" REJECTED ").pillLabel).toBe("REJECTED");
  });

  it("an executed draft reads EXECUTED; an approved draft reads APPROVED (authorization ≠ execution)", () => {
    expect(orderPreviewCardPresentation("executed")).toEqual({
      pillLabel: "EXECUTED",
      pillClass: "success",
    });
    expect(orderPreviewCardPresentation("filled").pillLabel).toBe("EXECUTED");
    expect(orderPreviewCardPresentation("approved")).toEqual({
      pillLabel: "APPROVED",
      pillClass: "success",
    });
    expect(orderPreviewCardPresentation("authorized").pillLabel).toBe("APPROVED");
  });

  it("an unrecognized reported status is shown verbatim, not relabelled as pending", () => {
    const p = orderPreviewCardPresentation("expired");
    expect(p.pillLabel).toBe("EXPIRED");
    expect(p.pillLabel).not.toBe("Awaiting Approval");
  });
});

// ===========================================================================
// Source pins — the fabrication cannot come back, and Chat is wired to
// the helpers rather than inline fallbacks.
// ===========================================================================

describe("#151 — source pins", () => {
  it("the fabricated proof signature appears nowhere in src/client", () => {
    const offenders = walk("src/client").filter((file) =>
      readFileSync(file, "utf8").includes(FABRICATED_SIGNATURE),
    );
    expect(offenders).toEqual([]);
  });

  it("the DID Proof modal renders via didProofSignatureDisplay, with no signature fallback", () => {
    // #2149: the modal moved with the payments page out of Chat.tsx.
    const page = src("client/PaymentsPage.tsx");
    expect(page).toContain("didProofSignatureDisplay(selectedProofTx.proofSignature)");
    expect(page).not.toMatch(/proofSignature\s*\|\|/);
  });

  it("the order-preview pill derives via orderPreviewCardPresentation, not the executed-or-pending binary", () => {
    const chat = src("client/chat/ToolResultView.tsx");
    expect(chat).toContain("orderPreviewCardPresentation(status)");
    expect(chat).not.toContain('? "EXECUTED" : "Awaiting Approval"');
  });

  it("no placeholder order ID is presented as a reserved E*TRADE order", () => {
    expect(src("client/chat/ToolResultView.tsx")).not.toContain("ord_preview");
  });
});
