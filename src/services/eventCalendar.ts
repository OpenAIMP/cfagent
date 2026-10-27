/**
 * Earnings / dividend event calendar (issue #16).
 *
 * Before #16 no earnings or ex-dividend date was connected anywhere: the
 * strategy engine's eventPolicy was binary-broken — "warn" (default) let
 * earnings-adjacent candidates rank as best with only a generic
 * "event risk is unverified" warning, and "exclude" withheld EVERY
 * candidate because verification was impossible.
 *
 * This service is the calendar source the engine now consumes. Per name
 * it exposes the next earnings and ex-dividend dates as whole days from
 * a reference instant, plus a coverage flag. Coverage is the honesty
 * contract: `covered: true` means a live source answered for the name
 * (the dates may still be null — no event is scheduled). Any failure —
 * no session, upstream error, malformed payload — is reported as
 * `covered: false` with null dates. The service never throws and never
 * guesses a date.
 *
 * Source: Yahoo Finance quoteSummary `calendarEvents` (the repo's
 * existing Yahoo crumb session, shared with marketDataResearch). Results are
 * cached per isolate with the same honesty properties as the quote
 * cache: only successful live (covered) results are cached, a cached
 * value keeps its original fetch timestamp, and the cache is bounded —
 * a cold isolate simply misses, so it can never become a correctness
 * dependency.
 */
import { getYahooCrumbSession } from "./marketDataResearch";
import type { EventCalendarInfo } from "../trading";

export const EVENT_CALENDAR_SOURCE = "yahoo-calendarEvents";
export const EVENT_CALENDAR_CACHE_TTL_MS = 6 * 60 * 60_000;
export const EVENT_CALENDAR_CACHE_MAX_ENTRIES = 500;
/** Keep options scans below the Workers Free 50-external-subrequest cap. */
export const EVENT_CALENDAR_MAX_SCAN_FETCHES = 5;

export interface SymbolEventCalendar extends EventCalendarInfo {
  symbol: string;
  /** ISO timestamp of the live fetch that produced this record. */
  fetchedAt: string;
}

interface CacheEntry {
  value: SymbolEventCalendar;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: clear all entries (mirrors __resetQuoteCache). */
export function __resetEventCalendarCache(): void {
  cache.clear();
}

const DAY_MS = 24 * 60 * 60_000;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole days from the reference instant's UTC date to an ISO date (YYYY-MM-DD). */
function daysUntil(isoDate: string, nowMs: number): number {
  const [y, m, d] = isoDate.split("-").map((part) => Number(part));
  return Math.round((Date.UTC(y, (m || 1) - 1, d || 1) - utcDayStart(nowMs)) / DAY_MS);
}

interface YahooDateNode {
  raw?: number;
  fmt?: string;
}

function isoFromNode(node: YahooDateNode | undefined): string | null {
  if (!node) return null;
  if (typeof node.fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(node.fmt)) return node.fmt;
  if (typeof node.raw === "number" && Number.isFinite(node.raw)) {
    return new Date(node.raw * 1000).toISOString().slice(0, 10);
  }
  return null;
}

/** Earliest upcoming (today or later) ISO date among the nodes, or null. */
function nextUpcoming(nodes: YahooDateNode[] | undefined, todayIso: string): string | null {
  if (!Array.isArray(nodes)) return null;
  const upcoming = nodes
    .map((node) => isoFromNode(node))
    .filter((iso): iso is string => iso !== null && iso >= todayIso)
    .sort();
  return upcoming[0] ?? null;
}

function uncovered(symbol: string, fetchedAt: string): SymbolEventCalendar {
  return {
    symbol,
    covered: false,
    source: EVENT_CALENDAR_SOURCE,
    earningsDate: null,
    daysToEarnings: null,
    exDividendDate: null,
    daysToExDiv: null,
    fetchedAt,
  };
}

function cachedCalendar(symbol: string, nowMs: number): SymbolEventCalendar | null {
  const cached = cache.get(symbol);
  if (!cached) return null;
  if (cached.expiresAt > nowMs) return cached.value;
  cache.delete(symbol);
  return null;
}

/**
 * The next earnings / ex-dividend dates for one name. `nowMs` is the
 * reference instant for the day counts (injectable for tests and for
 * run-level provenance consistency).
 */
export async function getSymbolEventCalendar(
  symbol: string,
  nowMs: number = Date.now()
): Promise<SymbolEventCalendar> {
  const cleanSym = symbol.toUpperCase().trim();
  const fetchedAt = new Date(nowMs).toISOString();

  const cached = cachedCalendar(cleanSym, nowMs);
  if (cached) return cached;

  let result: SymbolEventCalendar;
  try {
    const session = await getYahooCrumbSession();
    if (!session) return uncovered(cleanSym, fetchedAt);
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(cleanSym)}?modules=calendarEvents&crumb=${encodeURIComponent(session.crumb)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: session.cookie,
        Accept: "application/json",
      },
    });
    if (!res.ok) return uncovered(cleanSym, fetchedAt);
    const data = (await res.json().catch(() => ({}))) as {
      quoteSummary?: { result?: Array<{ calendarEvents?: {
        earnings?: { earningsDate?: YahooDateNode[] };
        exDividendDate?: YahooDateNode;
      } }> };
    };
    const calendarEvents = data?.quoteSummary?.result?.[0]?.calendarEvents;
    if (!calendarEvents || typeof calendarEvents !== "object") {
      return uncovered(cleanSym, fetchedAt);
    }
    const todayIso = new Date(utcDayStart(nowMs)).toISOString().slice(0, 10);
    const earningsDate = nextUpcoming(calendarEvents.earnings?.earningsDate, todayIso);
    const exDivIso = isoFromNode(calendarEvents.exDividendDate);
    const exDividendDate = exDivIso !== null && exDivIso >= todayIso ? exDivIso : null;
    result = {
      symbol: cleanSym,
      covered: true,
      source: EVENT_CALENDAR_SOURCE,
      earningsDate,
      daysToEarnings: earningsDate ? daysUntil(earningsDate, nowMs) : null,
      exDividendDate,
      daysToExDiv: exDividendDate ? daysUntil(exDividendDate, nowMs) : null,
      fetchedAt,
    };
  } catch {
    return uncovered(cleanSym, fetchedAt);
  }

  if (cache.size >= EVENT_CALENDAR_CACHE_MAX_ENTRIES && !cache.has(cleanSym)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(cleanSym, { value: result, expiresAt: nowMs + EVENT_CALENDAR_CACHE_TTL_MS });
  return result;
}

/**
 * The engine-facing projection of a symbol calendar: the request field
 * is EventCalendarInfo, and symbol/fetchedAt are service bookkeeping.
 * Keeping them out of engine requests means identical calendar facts
 * produce identical requests — and identical responses (the #314
 * byte-identity contract between the two recommend-route spellings).
 */
export function toEventCalendarInfo(cal: SymbolEventCalendar): EventCalendarInfo {
  return {
    covered: cal.covered,
    source: cal.source,
    earningsDate: cal.earningsDate,
    daysToEarnings: cal.daysToEarnings,
    exDividendDate: cal.exDividendDate,
    daysToExDiv: cal.daysToExDiv,
  };
}

export interface EventCalendarCoverage {
  bySymbol: Map<string, SymbolEventCalendar>;
  total: number;
  coveredCount: number;
  /** Percentage of names with live calendar coverage, one decimal. */
  coveragePct: number;
}

/**
 * Calendar coverage for a set of names — the per-run provenance figure
 * scan/discovery surfaces report (issue #16: "Coverage is reported per
 * run"). Duplicate and blank symbols are collapsed before counting.
 */
export async function getEventCalendarCoverage(
  symbols: string[],
  nowMs: number = Date.now(),
  maxFetches: number = EVENT_CALENDAR_MAX_SCAN_FETCHES
): Promise<EventCalendarCoverage> {
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
  const bySymbol = new Map<string, SymbolEventCalendar>();
  const fetchLimit = Math.max(0, Math.floor(maxFetches));
  await Promise.all(unique.map(async (sym, index) => {
    // Preserve fresh cache hits without spending a subrequest. On a cold
    // isolate, fetch only a bounded prefix and label the tail uncovered;
    // otherwise a 100-name options scan would exhaust the Worker request
    // ceiling in Yahoo before the E*TRADE scanner starts.
    const cached = cachedCalendar(sym, nowMs);
    if (cached) {
      bySymbol.set(sym, cached);
    } else if (index < fetchLimit) {
      bySymbol.set(sym, await getSymbolEventCalendar(sym, nowMs));
    } else {
      bySymbol.set(sym, uncovered(sym, new Date(nowMs).toISOString()));
    }
  }));
  const coveredCount = Array.from(bySymbol.values()).filter((entry) => entry.covered).length;
  return {
    bySymbol,
    total: unique.length,
    coveredCount,
    coveragePct: unique.length ? Math.round((coveredCount / unique.length) * 1000) / 10 : 0,
  };
}
