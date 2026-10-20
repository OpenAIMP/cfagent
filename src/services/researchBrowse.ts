/**
 * Issue #341: flatten the §8 watchlist and rejected-with-reasons sets out
 * of stored canonical research reports into browsable entries. Pure and
 * defensive: bodies that are not pipeline research runs contribute
 * nothing, and malformed entries are skipped rather than failing the
 * whole browse.
 */

export interface ResearchBrowseEntry {
  kind: "watchlist" | "rejected";
  symbol: string;
  outlook: string;
  structure: string;
  /** Watchlist: thesis. Rejected: empty. */
  thesis: string;
  /** Human-readable reason (both kinds carry one). */
  reason: string;
  /** Rejected only: the gate code that rejected the idea ("" otherwise). */
  gate: string;
  /** Watchlist only: what would promote the idea ("" otherwise). */
  triggerCondition: string;
  /** Provenance: the stored report this entry came from. */
  reportId: string;
  reportTitle: string;
  runCreatedAt: string;
}

interface StoredReportLike {
  id: string;
  title: string;
  createdAt: string;
  body: string;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function extractResearchBrowseEntries(
  reports: StoredReportLike[]
): ResearchBrowseEntry[] {
  const entries: ResearchBrowseEntry[] = [];
  for (const report of reports) {
    let body: unknown;
    try {
      body = JSON.parse(report.body);
    } catch {
      continue;
    }
    if (!isObj(body)) continue;
    const provenance = {
      reportId: report.id,
      reportTitle: report.title,
      runCreatedAt: report.createdAt,
    };
    if (Array.isArray(body.watchlist)) {
      for (const w of body.watchlist as any[]) {
        if (!isObj(w) || !str(w.symbol)) continue;
        entries.push({
          kind: "watchlist",
          symbol: str(w.symbol),
          outlook: str(w.outlook),
          structure: str(w.structure),
          thesis: str(w.thesis),
          reason: str(w.reason),
          gate: "",
          triggerCondition: str(w.triggerCondition),
          ...provenance,
        });
      }
    }
    if (Array.isArray(body.rejected)) {
      for (const r of body.rejected as any[]) {
        if (!isObj(r) || !str(r.symbol)) continue;
        entries.push({
          kind: "rejected",
          symbol: str(r.symbol),
          outlook: str(r.outlook),
          structure: str(r.structure),
          thesis: "",
          reason: str(r.reason),
          gate: str(r.gate),
          triggerCondition: "",
          ...provenance,
        });
      }
    }
  }
  return entries;
}

/** Distinct rejected-gate codes present in a set of entries, sorted. */
export function researchBrowseGates(entries: ResearchBrowseEntry[]): string[] {
  const gates = new Set<string>();
  for (const e of entries) {
    if (e.kind === "rejected" && e.gate) gates.add(e.gate);
  }
  return [...gates].sort();
}
