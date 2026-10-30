/**
 * Monetization Phase 1.1 (#2406, sub-issue of #2405): per-path
 * real-vs-simulated labeling for x402 payments.
 *
 * The label describes the SETTLEMENT PATH, never a single payment's
 * verification status — verification happens per payment in
 * src/services/x402Verifier.ts (verifyOnChainClaim) and in
 * ETradeAgenticPaymentService.verifyPayment, which fail closed.
 *
 * - "onchain": the payer makes an on-chain USDC transfer that the
 *   verifier checks against the chain. On a testnet network
 *   (base-sepolia) that transfer moves testnet funds — no real money.
 *   On a mainnet network (base) it moves real funds.
 * - "simulated": the local-ledger agent-wallet path
 *   (src/services/agenticPayments.ts signPaymentProof /
 *   synthesizeReceipt, issue #122). No real payment is collected or
 *   verified on this path, and it must never be presented as one:
 *   verifyPayment rejects simulated proofs outright.
 *
 * This module is pure (static network table only): labeling a price
 * adds NO per-request store read, so it cannot trip the #1819
 * rows-read lens.
 */
import { resolveX402Network } from "./x402Networks";

export type X402PaymentPathKind = "onchain" | "simulated";

export interface X402PaymentPathLabel {
  kind: X402PaymentPathKind;
  /** True only when the network is a known testnet. Unknown networks are never labeled testnet. */
  testnet: boolean;
  /** The network string as configured (e.g. "base-sepolia"), or "simulated" for the local-ledger path. */
  network: string;
  /** Human-readable network name when known, else the raw network string. */
  networkName: string;
  /** Full sentence for API bodies and user-facing messages. */
  label: string;
  /** Short parenthetical for price lines, e.g. "testnet — testnet funds, no real money". */
  shortLabel: string;
}

export function describeX402PaymentPath(
  network: string | undefined,
  opts: { simulated?: boolean } = {},
): X402PaymentPathLabel {
  if (opts.simulated) {
    return {
      kind: "simulated",
      testnet: false,
      network: "simulated",
      networkName: "simulated local ledger",
      label: "Simulated — no real payment was collected or verified.",
      shortLabel: "simulated — no real payment",
    };
  }
  const raw = (network || "").trim();
  const net = resolveX402Network(raw || undefined);
  if (!net) {
    return {
      kind: "onchain",
      testnet: false,
      network: raw || "unknown",
      networkName: raw || "unknown network",
      label: `Payment network "${raw || "unknown"}" is not recognized — this path cannot be labeled testnet or mainnet, and no payment on it may be treated as verified.`,
      shortLabel: "network not recognized",
    };
  }
  if (net.testnet) {
    return {
      kind: "onchain",
      testnet: true,
      network: raw,
      networkName: net.name,
      label: `Testnet payment on ${net.name} — an on-chain USDC transfer in testnet funds (no real money).`,
      shortLabel: "testnet — testnet funds, no real money",
    };
  }
  return {
    kind: "onchain",
    testnet: false,
    network: raw,
    networkName: net.name,
    label: `Real payment on ${net.name} — an on-chain USDC transfer in real funds.`,
    shortLabel: "real funds",
  };
}
