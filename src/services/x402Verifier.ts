import { recoverMessageAddress } from "viem";
import type { X402PaymentProof } from "../types";
import { resolveX402Network, usdToAtomic, x402ClaimMessage } from "./x402Networks";

export interface X402ClaimInput {
  proof: X402PaymentProof;
  resource: string;
  amountUSD: number;
  recipient: string;
  network: string;
}

export type X402ClaimResult =
  | { ok: true; payer: string; txHash: string }
  | { ok: false; reason: string; retryable?: boolean };

export type X402ClaimVerifier = (input: X402ClaimInput) => Promise<X402ClaimResult>;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`RPC request failed [HTTP ${response.status}].`);
  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(`RPC error: ${payload.error.message || "unknown"}`);
  if (payload.result === undefined) throw new Error("RPC returned an invalid response.");
  return payload.result;
}

const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/**
 * Verifies that the payer signed the claim and that the referenced transaction
 * is a successful USDC transfer from that payer to the recipient for at least the price.
 * Fails closed on any error.
 */
export const verifyOnChainClaim: X402ClaimVerifier = async ({ proof, resource, amountUSD, recipient, network }) => {
  const net = resolveX402Network(network);
  if (!net) return { ok: false, reason: `Unsupported payment network: ${network}.` };
  const txHash = proof.txHash || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "A valid 32-byte transaction hash is required." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(proof.payer || "")) return { ok: false, reason: "A valid payer address is required." };
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return { ok: false, reason: "Payment recipient is not configured." };

  try {
    const signer = await recoverMessageAddress({
      message: x402ClaimMessage(txHash, resource),
      signature: proof.signature as `0x${string}`,
    });
    if (signer.toLowerCase() !== proof.payer.toLowerCase()) {
      return { ok: false, reason: "Payment claim signature does not match the payer." };
    }
  } catch {
    return { ok: false, reason: "Payment claim signature is invalid." };
  }

  try {
    const chainId = await rpcCall<string>(net.rpcUrl, "eth_chainId", []);
    if (chainId.toLowerCase() !== net.chainIdHex) return { ok: false, reason: "Payment RPC responded with an unexpected chain." };

    const receipt = await rpcCall<{ status?: string; logs?: Array<{ address?: string; topics?: string[]; data?: string }> } | null>(
      net.rpcUrl,
      "eth_getTransactionReceipt",
      [txHash],
    );
    if (!receipt) {
      return { ok: false, retryable: true, reason: "Payment transaction is not yet visible on-chain. Retry shortly; do not pay again." };
    }
    if (receipt.status !== "0x1") return { ok: false, reason: "Payment transaction did not succeed on-chain." };

    const required = usdToAtomic(amountUSD, net.usdcDecimals);
    const matched = (receipt.logs || []).some((log) =>
      log.address?.toLowerCase() === net.usdc.toLowerCase() &&
      log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
      log.topics?.[1]?.toLowerCase() === addressTopic(proof.payer) &&
      log.topics?.[2]?.toLowerCase() === addressTopic(recipient) &&
      typeof log.data === "string" && /^0x[0-9a-fA-F]{64}$/.test(log.data) && BigInt(log.data) >= required,
    );
    if (!matched) {
      return { ok: false, reason: "No matching USDC transfer from the payer to the recipient for the required amount." };
    }
    return { ok: true, payer: proof.payer, txHash };
  } catch (error) {
    return { ok: false, retryable: true, reason: `Payment verification unavailable: ${error instanceof Error ? error.message : "unknown error"}` };
  }
};
