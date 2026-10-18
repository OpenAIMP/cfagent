/**
 * Presentation derivation for the DID Proof modal's proof-signature
 * field (issue #151, follow-up to #122 / #141). Extracted as a pure
 * helper — the src/client/executionCard.ts pattern — so the honesty
 * contract is unit-testable without rendering the Chat tree.
 *
 * The contract: the modal shows the transaction's REAL proof signature
 * verbatim when one exists. When the record carries no signature, the
 * modal states that plainly — it must NEVER substitute a plausible-
 * looking hard-coded signature, which is what the old
 * `proofSignature || "0x4b78…"` fallback did: a fabricated
 * cryptographic proof presented to the user as the transaction's own.
 * (The fabricated literal is source-pinned by
 * tests/did_proof_honesty.test.ts so it cannot reappear in src/client.)
 */

/** Shown in place of a signature when the record carries none. */
export const NO_PROOF_SIGNATURE_MESSAGE = "No proof signature available";

/**
 * The text for the modal's "Cryptographic Proof Signature" field: the
 * record's signature verbatim when a non-empty one is present, the
 * honest absence message otherwise (missing, null, empty, whitespace,
 * or a non-string value all count as absent — never a substitute).
 */
export function didProofSignatureDisplay(proofSignature: unknown): string {
  return typeof proofSignature === "string" && proofSignature.trim()
    ? proofSignature
    : NO_PROOF_SIGNATURE_MESSAGE;
}
