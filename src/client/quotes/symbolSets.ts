/**
 * Issue #2100 — the single home for ticker symbol sets.
 *
 * Before this module, the tape hardcoded 10 symbols and the search bar
 * hardcoded 13; the two shared 9 and had already drifted (DIA tape-only;
 * AMD/AMZN/META/GOOGL search-only). Sets are data here, so a future
 * picker (slice D) resolves a set instead of editing two constants.
 * The landing set joins in slice E, mapped to feed-servable symbols.
 */

export interface QuoteSymbolMeta {
  symbol: string;
  name?: string;
  type: "stock" | "crypto" | "etf";
  /** Baseline display values shown until the first live quote arrives. */
  price?: string;
  change?: string;
  isPositive?: boolean;
  volume?: string;
  pe?: string;
}

/** The in-app tape set (10). */
export const TAPE_SYMBOLS: QuoteSymbolMeta[] = [
  { symbol: "SPY", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "QQQ", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "DIA", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "NVDA", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "AAPL", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "MSFT", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "TSLA", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "BTC/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
  { symbol: "ETH/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
  { symbol: "SOL/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
];

/** A set entry with a display name (search rows, palette labels). */
export interface NamedQuoteSymbol extends QuoteSymbolMeta {
  name: string;
}

/** The search modal set (13). Kept as the historical POPULAR_TICKERS. */
export const SEARCH_SYMBOLS: NamedQuoteSymbol[] = [
  { symbol: "NVDA", name: "NVIDIA Corporation", price: "$138.25", change: "+3.42%", isPositive: true, type: "stock", volume: "48.2M", pe: "54.2" },
  { symbol: "AAPL", name: "Apple Inc.", price: "$232.10", change: "+0.84%", isPositive: true, type: "stock", volume: "32.1M", pe: "34.1" },
  { symbol: "TSLA", name: "Tesla Inc.", price: "$220.50", change: "-1.24%", isPositive: false, type: "stock", volume: "65.4M", pe: "68.3" },
  { symbol: "MSFT", name: "Microsoft Corporation", price: "$428.90", change: "+1.15%", isPositive: true, type: "stock", volume: "21.0M", pe: "36.2" },
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", price: "$582.40", change: "+0.52%", isPositive: true, type: "etf", volume: "41.5M" },
  { symbol: "QQQ", name: "Invesco QQQ Trust", price: "$492.15", change: "+0.94%", isPositive: true, type: "etf", volume: "29.8M" },
  { symbol: "BTC/USD", name: "Bitcoin", price: "$67,450.00", change: "+2.14%", isPositive: true, type: "crypto", volume: "$28.4B" },
  { symbol: "ETH/USD", name: "Ethereum", price: "$2,642.50", change: "+1.52%", isPositive: true, type: "crypto", volume: "$14.1B" },
  { symbol: "SOL/USD", name: "Solana", price: "$154.20", change: "+3.91%", isPositive: true, type: "crypto", volume: "$4.8B" },
  { symbol: "AMD", name: "Advanced Micro Devices", price: "$156.40", change: "+2.18%", isPositive: true, type: "stock", volume: "38.0M", pe: "104.2" },
  { symbol: "AMZN", name: "Amazon.com Inc.", price: "$187.80", change: "+1.65%", isPositive: true, type: "stock", volume: "27.5M", pe: "42.1" },
  { symbol: "META", name: "Meta Platforms Inc.", price: "$592.30", change: "+1.88%", isPositive: true, type: "stock", volume: "15.2M", pe: "27.8" },
  { symbol: "GOOGL", name: "Alphabet Inc.", price: "$168.50", change: "+0.72%", isPositive: true, type: "stock", volume: "19.3M", pe: "23.4" },
];
