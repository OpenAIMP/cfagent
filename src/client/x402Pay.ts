import { resolveX402Network, usdToAtomic, x402ClaimMessage } from "../services/x402Networks";

export interface X402Challenge {
  network: string;
  recipient: string;
  amount: number;
  currency: string;
  resource: string;
  nonce: string;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const getProvider = (): Eip1193Provider => {
  const provider = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (!provider) throw new Error("No Ethereum wallet found. Install MetaMask to pay for this screener.");
  return provider;
};

const pad32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeChallenge(challenge: X402Challenge) {
  const net = resolveX402Network(challenge.network);
  return { net, label: net ? `${net.name} USDC` : challenge.network };
}

async function ensureChain(provider: Eip1193Provider, chainIdHex: string, net: NonNullable<ReturnType<typeof resolveX402Network>>) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainIdHex,
        chainName: net.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [net.rpcUrl],
        blockExplorerUrls: [net.explorerTxUrl.replace(/\/tx\/$/, "")],
      }],
    });
  }
}

export interface PaidTransfer {
  payer: string;
  txHash: string;
}

/** Sends the USDC transfer from the user's wallet and waits until it is mined. */
export async function sendUsdcPayment(challenge: X402Challenge, onStatus: (message: string) => void): Promise<PaidTransfer> {
  const net = resolveX402Network(challenge.network);
  if (!net) throw new Error(`Unsupported payment network: ${challenge.network}`);
  const provider = getProvider();

  onStatus("Connecting wallet…");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const payer = accounts[0];
  if (!payer) throw new Error("No wallet account was selected.");

  await ensureChain(provider, net.chainIdHex, net);

  const data = `0xa9059cbb${pad32(challenge.recipient)}${pad32(usdToAtomic(challenge.amount, net.usdcDecimals).toString(16))}`;
  onStatus(`Confirm the ${challenge.amount.toFixed(2)} USDC transfer in your wallet…`);
  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: payer, to: net.usdc, data, value: "0x0" }],
  })) as string;

  onStatus("Waiting for the transaction to be mined…");
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("The USDC transfer failed on-chain. You were not charged for the screener.");
      return { payer, txHash };
    }
    await sleep(2_000);
  }
  throw new Error(`Transaction ${txHash} is still pending. Try again in a moment; do not pay twice.`);
}

/** Signs the claim that binds this transaction to the resource and returns the PAYMENT-SIGNATURE header value. */
export async function buildPaymentSignature(challenge: X402Challenge, paid: PaidTransfer): Promise<string> {
  const signature = (await getProvider().request({
    method: "personal_sign",
    params: [x402ClaimMessage(paid.txHash, challenge.resource), paid.payer],
  })) as string;
  const proof = { signature, payer: paid.payer, txHash: paid.txHash, nonce: challenge.nonce, timestamp: Date.now() };
  return btoa(JSON.stringify(proof));
}
