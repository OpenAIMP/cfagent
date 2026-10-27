/**
 * Issue #1118 (P1 of epic #1116): the provider conformance kit —
 * SCAFFOLD.
 *
 * Drop-in replacement (epic #1116) is only real if "implements the
 * contract" is checkable: any provider — built-in or provisioned
 * later — must pass the same per-capability shape assertions before
 * the provisioning lifecycle (P4) may mark it verified/enabled. This
 * module is that shared check, expressed once, against the contract's
 * normalized shapes.
 *
 * Scaffold scope, deliberately: assertions are STRUCTURAL over the
 * provenance envelope and its payload (envelope present, providerId
 * honestly naming the provider under test, capability tag matching
 * the probe, required payload fields present and of the right kind,
 * symbol echoing the probe) for a canonical probe. They run in tests
 * against fixture-backed implementations — no live network in CI.
 * Later slices extend the kit (freshness, cross-provider parity,
 * live probes at provisioning time); the report shape is the stable
 * surface those extensions plug into.
 *
 * The kit NEVER throws: a provider error is a failed check, not a
 * crashed run. A provider that declares a capability it does not
 * implement fails that capability's check.
 */

import type {
  DataProvider,
  DataProviderCapability,
  DataProviderId,
  OptionsChainRequest,
} from "./contract";

export interface ConformanceCheck {
  capability: DataProviderCapability;
  ok: boolean;
  failures: string[];
}

export interface ConformanceReport {
  providerId: DataProviderId;
  ok: boolean;
  checks: ConformanceCheck[];
}

export interface ConformanceProbe {
  /** Symbol used for the symbol-scoped capabilities. Defaults to "AAPL". */
  symbol?: string;
  /** Chain request for optionsChains. Defaults to { symbol, chainType: "CALLPUT" }. */
  chainRequest?: OptionsChainRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkQuote(result: unknown, symbol: string): string[] {
  const failures: string[] = [];
  if (!isRecord(result)) return ["quote result is not an object"];
  if (result.symbol !== symbol) {
    failures.push(`quote symbol "${String(result.symbol)}" does not echo probe symbol "${symbol}"`);
  }
  // Both normalized quote shapes carry a numeric price (lastPrice on
  // ETradeQuote, price/lastPrice on MarketDataResearchQuote).
  const price = result.lastPrice ?? result.price;
  if (typeof price !== "number" || Number.isNaN(price)) {
    failures.push("quote has no numeric lastPrice/price");
  }
  if (typeof result.timestamp !== "string" || result.timestamp === "") {
    failures.push("quote has no timestamp string");
  }
  return failures;
}

function checkOptionsChain(result: unknown, symbol: string): string[] {
  // null is a conformant answer: the provider has no chain for the request.
  if (result === null) return [];
  if (!isRecord(result)) return ["options chain result is neither an object nor null"];
  const failures: string[] = [];
  if (result.symbol !== symbol) {
    failures.push(`chain symbol "${String(result.symbol)}" does not echo probe symbol "${symbol}"`);
  }
  if (!Array.isArray(result.pairs)) {
    failures.push("options chain has no pairs array");
  }
  return failures;
}

function checkScreenUniverse(result: unknown): string[] {
  if (!Array.isArray(result)) return ["screen universe result is not an array"];
  const failures: string[] = [];
  for (const [i, item] of result.entries()) {
    if (!isRecord(item) || typeof item.symbol !== "string" || typeof item.companyName !== "string") {
      failures.push(`universe entry ${i} lacks a string symbol/companyName`);
      break;
    }
  }
  return failures;
}

function checkHistoricalBars(result: unknown): string[] {
  if (!Array.isArray(result)) return ["historical bars result is not an array"];
  const failures: string[] = [];
  for (const [i, bar] of result.entries()) {
    if (
      !isRecord(bar) ||
      typeof bar.open !== "number" ||
      typeof bar.high !== "number" ||
      typeof bar.low !== "number" ||
      typeof bar.close !== "number" ||
      typeof bar.timestamp !== "string"
    ) {
      failures.push(`bar ${i} lacks numeric open/high/low/close or a timestamp string`);
      break;
    }
  }
  return failures;
}

function checkFundamentals(result: unknown, symbol: string): string[] {
  if (!isRecord(result)) return ["fundamentals result is not an object"];
  const failures: string[] = [];
  if (result.symbol !== symbol) {
    failures.push(`fundamentals symbol "${String(result.symbol)}" does not echo probe symbol "${symbol}"`);
  }
  if (typeof result.companyName !== "string" || result.companyName === "") {
    failures.push("fundamentals have no companyName string");
  }
  return failures;
}

function checkNews(result: unknown): string[] {
  if (!Array.isArray(result)) return ["news result is not an array"];
  const failures: string[] = [];
  for (const [i, article] of result.entries()) {
    if (
      !isRecord(article) ||
      typeof article.headline !== "string" ||
      typeof article.publishedAt !== "string"
    ) {
      failures.push(`news article ${i} lacks a headline/publishedAt string`);
      break;
    }
  }
  return failures;
}

/**
 * Verify the provenance envelope and hand back the payload for shape
 * checks. An untagged result, a providerId that mislabels the serving
 * provider, or a capability tag that disagrees with the probe are all
 * conformance failures — provenance honesty is part of the contract.
 */
function unwrapEnvelope(
  provider: DataProvider,
  capability: DataProviderCapability,
  envelope: unknown,
  failures: string[]
): unknown {
  if (!isRecord(envelope) || !("result" in envelope)) {
    failures.push(
      `${capability} result is not a provenance envelope ({ providerId, capability, result })`
    );
    return undefined;
  }
  if (envelope.providerId !== provider.id) {
    failures.push(
      `provenance providerId "${String(envelope.providerId)}" does not match the serving provider "${provider.id}"`
    );
  }
  if (envelope.capability !== capability) {
    failures.push(
      `provenance capability "${String(envelope.capability)}" does not match the probed capability "${capability}"`
    );
  }
  return envelope.result;
}

/**
 * Run the conformance checks for every capability the provider
 * DECLARES. Undeclared capabilities are not probed — declaring a
 * capability is the provider's claim; the kit verifies claims.
 */
export async function runDataProviderConformance(
  provider: DataProvider,
  probe: ConformanceProbe = {}
): Promise<ConformanceReport> {
  const symbol = probe.symbol ?? "AAPL";
  const chainRequest = probe.chainRequest ?? { symbol, chainType: "CALLPUT" as const };
  const checks: ConformanceCheck[] = [];

  for (const capability of provider.capabilities) {
    const failures: string[] = [];
    try {
      switch (capability) {
        case "quotes":
          if (!provider.getQuote) failures.push("declares quotes but does not implement getQuote");
          else failures.push(...checkQuote(unwrapEnvelope(provider, capability, await provider.getQuote(symbol), failures), symbol));
          break;
        case "optionsChains":
          if (!provider.getOptionsChain) failures.push("declares optionsChains but does not implement getOptionsChain");
          else failures.push(...checkOptionsChain(unwrapEnvelope(provider, capability, await provider.getOptionsChain(chainRequest), failures), symbol));
          break;
        case "screenUniverse":
          if (!provider.getScreenUniverse) failures.push("declares screenUniverse but does not implement getScreenUniverse");
          else failures.push(...checkScreenUniverse(unwrapEnvelope(provider, capability, await provider.getScreenUniverse(), failures)));
          break;
        case "historicalBars":
          if (!provider.getHistoricalBars) failures.push("declares historicalBars but does not implement getHistoricalBars");
          else failures.push(...checkHistoricalBars(unwrapEnvelope(provider, capability, await provider.getHistoricalBars(symbol), failures)));
          break;
        case "fundamentals":
          if (!provider.getFundamentals) failures.push("declares fundamentals but does not implement getFundamentals");
          else failures.push(...checkFundamentals(unwrapEnvelope(provider, capability, await provider.getFundamentals(symbol), failures), symbol));
          break;
        case "news":
          if (!provider.getNews) failures.push("declares news but does not implement getNews");
          else failures.push(...checkNews(unwrapEnvelope(provider, capability, await provider.getNews(symbol), failures)));
          break;
      }
    } catch (err) {
      failures.push(
        `provider threw during ${capability} probe: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    checks.push({ capability, ok: failures.length === 0, failures });
  }

  return {
    providerId: provider.id,
    ok: checks.every((c) => c.ok),
    checks,
  };
}
