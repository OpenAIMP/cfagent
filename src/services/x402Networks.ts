export interface X402NetworkInfo {
  caip2: string;
  name: string;
  chainId: number;
  chainIdHex: string;
  usdc: string;
  usdcDecimals: number;
  rpcUrl: string;
  explorerTxUrl: string;
  testnet: boolean;
}

const NETWORKS: X402NetworkInfo[] = [
  {
    caip2: "eip155:84532",
    name: "Base Sepolia",
    chainId: 84532,
    chainIdHex: "0x14a34",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDecimals: 6,
    rpcUrl: "https://sepolia.base.org",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
    testnet: true,
  },
  {
    caip2: "eip155:8453",
    name: "Base",
    chainId: 8453,
    chainIdHex: "0x2105",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    rpcUrl: "https://mainnet.base.org",
    explorerTxUrl: "https://basescan.org/tx/",
    testnet: false,
  },
];

const ALIASES: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
};

/** Resolves a legacy name (base-sepolia) or CAIP-2 id to supported network details. */
export function resolveX402Network(network: string | undefined): X402NetworkInfo | null {
  const key = (network || "").trim().toLowerCase();
  const caip2 = ALIASES[key] || key;
  return NETWORKS.find((entry) => entry.caip2 === caip2) || null;
}

export function usdToAtomic(amountUSD: number, decimals = 6): bigint {
  return BigInt(Math.round(amountUSD * 10 ** decimals));
}

/** Message the payer signs to bind an on-chain transfer to a single paid resource. */
export function x402ClaimMessage(txHash: string, resource: string): string {
  return `cfagent x402 payment claim\ntx:${txHash.toLowerCase()}\nresource:${resource}`;
}
