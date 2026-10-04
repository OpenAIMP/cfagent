import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyOnChainClaim } from "../src/services/x402Verifier";
import { resolveX402Network, x402ClaimMessage } from "../src/services/x402Networks";

const net = resolveX402Network("base-sepolia")!;
const payerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const payer = privateKeyToAccount(payerKey);
const recipient = "0x71C8363837918a211797E3c76A8B3C4258759550";
const txHash = `0x${"ab".repeat(32)}`;
const resource = "/api/premium/options-scan";
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const goodLog = (atomic: bigint) => ({
  address: net.usdc,
  topics: [TRANSFER, pad(payer.address), pad(recipient)],
  data: `0x${atomic.toString(16).padStart(64, "0")}`,
});

function mockRpc(receipt: unknown, chainId = net.chainIdHex) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    const result = method === "eth_chainId" ? chainId : receipt;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
}

async function claim(overrides: Record<string, unknown> = {}, amountUSD = 0.05) {
  const signature = await payer.signMessage({ message: x402ClaimMessage(txHash, resource) });
  return verifyOnChainClaim({
    proof: { signature, payer: payer.address, txHash, nonce: "n", timestamp: Date.now(), ...overrides },
    resource,
    amountUSD,
    recipient,
    network: "base-sepolia",
  });
}

describe("x402 on-chain claim verification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a successful USDC transfer from the payer to the recipient", async () => {
    mockRpc({ status: "0x1", logs: [goodLog(50_000n)] });
    expect(await claim()).toMatchObject({ ok: true, txHash });
  });

  it("rejects an underpaid transfer", async () => {
    mockRpc({ status: "0x1", logs: [goodLog(49_999n)] });
    expect(await claim()).toMatchObject({ ok: false });
  });

  it("rejects a transfer to a different recipient or from the USDC-lookalike contract", async () => {
    mockRpc({ status: "0x1", logs: [{ ...goodLog(50_000n), address: "0x0000000000000000000000000000000000000001" }] });
    expect(await claim()).toMatchObject({ ok: false });
  });

  it("rejects a reverted transaction", async () => {
    mockRpc({ status: "0x0", logs: [goodLog(50_000n)] });
    expect(await claim()).toMatchObject({ ok: false, reason: expect.stringContaining("did not succeed") });
  });

  it("flags a not-yet-mined transaction as retryable", async () => {
    mockRpc(null);
    expect(await claim()).toMatchObject({ ok: false, retryable: true });
  });

  it("rejects a claim signed by someone other than the payer", async () => {
    mockRpc({ status: "0x1", logs: [goodLog(50_000n)] });
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signature = await other.signMessage({ message: x402ClaimMessage(txHash, resource) });
    expect(await claim({ signature })).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
  });

  it("rejects a claim signed for a different resource", async () => {
    mockRpc({ status: "0x1", logs: [goodLog(50_000n)] });
    const signature = await payer.signMessage({ message: x402ClaimMessage(txHash, "/api/premium/market-research") });
    expect(await claim({ signature })).toMatchObject({ ok: false });
  });

  it("rejects a missing tx hash and an RPC on the wrong chain", async () => {
    expect(await claim({ txHash: undefined })).toMatchObject({ ok: false });
    mockRpc({ status: "0x1", logs: [goodLog(50_000n)] }, "0x1");
    expect(await claim()).toMatchObject({ ok: false });
  });
});
