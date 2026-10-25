/**
 * Screener PDF reports (issue #269).
 *
 * Generates a screening report PDF with pdf-lib (pure JS, Workers-compatible —
 * no headless browser). Used by:
 *   - the scheduled tick → Slack file upload + email attachment
 *   - the manual run → downloadable via GET /api/screener/report.pdf
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { ScreenerRunResult } from "../agents/screener-agent";


/** Print palette (#473): PDFs render on white paper, so the report uses
 *  this named print scale — the print mirrors of the semantic text/status
 *  roles — instead of scattered rgb literals. pdf-lib 0..1 RGB triples. */
const PRINT_INK: [number, number, number] = [0.15, 0.15, 0.15];
const PRINT_LABEL: [number, number, number] = [0.35, 0.35, 0.35];
const PRINT_MUTED: [number, number, number] = [0.4, 0.4, 0.4];
const PRINT_NOTE: [number, number, number] = [0.45, 0.45, 0.45];
const PRINT_FAINT: [number, number, number] = [0.5, 0.5, 0.5];
const PRINT_HAIRLINE: [number, number, number] = [0.7, 0.7, 0.7];
const PRINT_DANGER: [number, number, number] = [0.8, 0.2, 0.2];
const PRINT_WARNING: [number, number, number] = [0.75, 0.45, 0];

const MARGIN = 36;
const PAGE_W = 612; // Letter
const PAGE_H = 792;
const CONTENT_W = PAGE_W - MARGIN * 2;

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx);
}

function cleanForPdf(str: string): string {
  return String(str ?? "")
    .replace(/Δ/g, "Delta ")
    .replace(/▲/g, "+")
    .replace(/▼/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/•/g, "*")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
}

function text(
  ctx: Ctx,
  rawStr: string,
  opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number } = {}
): void {
  const str = cleanForPdf(rawStr);
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  const c = opts.color ?? PRINT_INK;
  const x = opts.x ?? MARGIN;
  const maxWidth = PAGE_W - MARGIN - x;
  const words = str.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  for (const renderedLine of lines) {
    ensureSpace(ctx, size + 4);
    ctx.page.drawText(renderedLine, {
      x,
      y: ctx.y,
      size,
      font,
      color: rgb(c[0], c[1], c[2]),
    });
    ctx.y -= size + 4;
  }
}

function rule(ctx: Ctx): void {
  ensureSpace(ctx, 10);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.75,
    color: rgb(...PRINT_HAIRLINE),
  });
  ctx.y -= 10;
}

function fmt(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}${suffix}`;
}

function gapLabel(t: { gapPercent: number | null; gapDirection: string | null } | undefined | null): string {
  if (!t || t.gapPercent == null) return "-";
  const arrow = t.gapDirection === "up" ? "+" : t.gapDirection === "down" ? "-" : "";
  return `${arrow}${Math.abs(t.gapPercent).toFixed(1)}%`;
}

interface ColDef {
  header: string;
  w: number;
}

const ALL_STOCKS_COLS: ColDef[] = [
  { header: "Symbol", w: 50 },
  { header: "Company", w: 85 },
  { header: "Price", w: 45 },
  { header: "Chg%", w: 40 },
  { header: "Gap%", w: 42 },
  { header: "Sentiment", w: 55 },
  { header: "Quant", w: 58 },
  { header: "Val", w: 24 },
  { header: "Mom", w: 24 },
  { header: "RSI", w: 38 },
  { header: "MACD", w: 44 },
  { header: "Score", w: 35 },
];

function renderAllStocksHeader(ctx: Ctx): void {
  ensureSpace(ctx, 16);
  let x = MARGIN;
  for (const col of ALL_STOCKS_COLS) {
    ctx.page.drawText(col.header, { x, y: ctx.y, size: 8, font: ctx.bold, color: rgb(...PRINT_LABEL) });
    x += col.w;
  }
  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: rgb(...PRINT_HAIRLINE),
  });
  ctx.y -= 6;
}

/**
 * Issue #1278 (#1173 R5): provider-truthful provenance lines. The
 * pre-R5 report hardcoded "E*TRADE live snapshots" — and "No fallback
 * data substituted" — even on Yahoo runs, where both claims were false
 * (the manual NASDAQ100 incident report of 2026-10-23). The lines are
 * built from the run's recorded provider; legacy stored runs without
 * a provider keep the E*TRADE wording (they predate provider tagging).
 * Partial technicals coverage (R2's technicalsCoverage) is stated
 * explicitly so blank MACD/Gap columns are explained on the artifact.
 */
export function screenerProvenanceLines(result: {
  provider?: string;
  technicalsCoverage?: { symbols: number; withMacd: number; withGap: number };
}): { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } {
  const yahoo = result.provider === "yahoo";
  const lines: { quotesLine: string; methodologyQuotes: string; technicalsNote?: string } = yahoo
    ? {
        quotesLine: "Quotes: Yahoo Finance quotes (delayed)",
        methodologyQuotes:
          "Quotes: Yahoo Finance (delayed) — the quote source for this run.",
      }
    : {
        quotesLine: "Quotes: E*TRADE live snapshots",
        methodologyQuotes:
          "Quotes: E*TRADE live snapshots (primary). No fallback data substituted.",
      };
  const cov = result.technicalsCoverage;
  if (cov && cov.symbols > 0 && (cov.withMacd < cov.symbols || cov.withGap < cov.symbols)) {
    lines.technicalsNote =
      `Technicals coverage: MACD available for ${cov.withMacd} of ${cov.symbols} symbols, ` +
      `Gap% for ${cov.withGap} of ${cov.symbols}; blanks mean daily history was unavailable for that symbol.`;
  }
  return lines;
}

export async function generateScreenerPdf(
  result: ScreenerRunResult
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const prov = screenerProvenanceLines(result);
  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";

  // Header
  const universeLabel = (result.universe || "TECH").replace(/_/g, " ");
  text(ctx, `Stock Screener Report — ${universeLabel}`, { size: 16, bold: true });
  const sectorSegment = result.sector && result.sector !== "ALL" ? `  •  ${result.sector} sector` : "  •  All Sectors";
  text(ctx, `${triggerLabel}${sectorSegment}`, { size: 10, color: PRINT_MUTED });
  text(ctx, `Generated (UTC): ${result.timestamp}`, { size: 9, color: PRINT_MUTED });

  // Active Screening Criteria
  ensureSpace(ctx, 16);
  const activeCriteria = result.filterSummary || "Default criteria (Positive Day Change, Momentum Score >= 60, Quant Buy/Strong Buy)";
  text(ctx, `Active Criteria: ${activeCriteria}`, { size: 9, bold: true, color: PRINT_INK });
  rule(ctx);

  if (!result.success) {
    text(ctx, "Screen failed", { size: 13, bold: true, color: PRINT_DANGER });
    text(ctx, result.error || "E*TRADE unavailable — no market data.", { size: 10 });
    return doc.save();
  }

  // Partial screen notice
  if (result.partial) {
    const failed = result.partial.failedSymbols;
    const reasonSummary = Object.entries(result.partial.failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    text(ctx, "PARTIAL SCREEN — QUALIFIED RESULTS", { size: 12, bold: true, color: PRINT_WARNING });
    text(ctx, `${result.partial.quotedCount} of ${result.partial.requestedCount} symbols quoted; ${failed.length} unavailable (${failed.slice(0, 8).join(", ")}${failed.length > 8 ? ", ..." : ""}).`, { size: 9 });
    if (reasonSummary) text(ctx, `Failure reasons: ${reasonSummary}.`, { size: 9 });
    text(ctx, "Results below cover the quoted subset only; no fallback data substituted.", { size: 9 });
    rule(ctx);
  }

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(ctx, `Scanned: ${result.totalScanned}   Matched: ${result.matchedCount}   Standout Opportunities: ${result.opportunities.length}`);
  if (result.discoveryMessage) text(ctx, result.discoveryMessage, { size: 8, color: PRINT_MUTED });
  if (result.rejections && result.rejections.length > 0) {
    const counts: Record<string, number> = {};
    for (const r of result.rejections) {
      const gate = r.reason.split(" (")[0].split(" for ")[0].trim();
      counts[gate] = (counts[gate] || 0) + 1;
    }
    const breakdown = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${n} ${g}`)
      .join(", ");
    text(ctx, `Rejections Breakdown: ${breakdown}`, { size: 8, color: PRINT_NOTE });
  }
  rule(ctx);

  // Gaps summary
  const gappers = (result.allStocks || [])
    .filter((s) => s.technicals?.gapPercent != null)
    .sort((a, b) => Math.abs(b.technicals!.gapPercent!) - Math.abs(a.technicals!.gapPercent!))
    .slice(0, 8);
  const gapUps = gappers.filter((s) => s.technicals?.gapDirection === "up");
  const gapDowns = gappers.filter((s) => s.technicals?.gapDirection === "down");
  if (gappers.length > 0) {
    text(ctx, `Top gaps  (up: ${gapUps.length}   down: ${gapDowns.length})`, { size: 12, bold: true });
    for (const s of gappers) {
      text(ctx, `${s.symbol}  ${gapLabel(s.technicals)}  @ $${fmt(s.lastPrice)}`, { size: 9 });
    }
    rule(ctx);
  }

  // Opportunities
  text(ctx, "Standout Opportunities", { size: 12, bold: true });
  if (result.opportunities.length === 0) {
    text(ctx, "No standout opportunities met all criteria in this run.", { size: 9, color: PRINT_MUTED });
    rule(ctx);
  } else {
    // Header row
    const cols: Array<[string, number]> = [
      ["Symbol", 62], ["Quant", 78], ["Val", 34], ["Mom", 38],
      ["Sentiment", 84], ["Price", 62], ["Chg%", 56], ["Gap%", 62], ["RSI", 44],
    ];
    ensureSpace(ctx, 16);
    let x = MARGIN;
    for (const [label, w] of cols) {
      ctx.page.drawText(label, { x, y: ctx.y, size: 8, font: bold, color: rgb(...PRINT_LABEL) });
      x += w;
    }
    ctx.y -= 12;
    for (const o of result.opportunities) {
      ensureSpace(ctx, 13);
      x = MARGIN;
      const t = o.technicals;
      const cells: Array<[string, number]> = [
        [o.symbol, 62],
        [o.factorGrades?.quantRating ?? "-", 78],
        [o.factorGrades?.value ?? "-", 34],
        [o.factorGrades?.momentum ?? "-", 38],
        [(o.indicators?.sentiment ?? "neutral").replace(/_/g, " "), 84],
        [`$${fmt(o.lastPrice)}`, 62],
        [`${o.changePercent >= 0 ? "+" : ""}${fmt(o.changePercent, 2, "%")}`, 56],
        [gapLabel(t), 62],
        [fmt(t?.rsi14, 1), 44],
      ];
      for (const [val, w] of cells) {
        ctx.page.drawText(cleanForPdf(val).slice(0, 18), { x, y: ctx.y, size: 8, font, color: rgb(...PRINT_INK) });
        x += w;
      }
      ctx.y -= 11;
    }
    rule(ctx);
  }

  // Complete Screened Universe Table (allStocks)
  if (result.allStocks && result.allStocks.length > 0) {
    ensureSpace(ctx, 35);
    text(ctx, `All Screened Symbols (${result.allStocks.length})`, { size: 12, bold: true });
    text(ctx, `${prov.quotesLine}  |  Technicals (RSI, MACD, Gap%): Yahoo Finance daily history`, { size: 8, color: PRINT_MUTED });
    ctx.y -= 4;
    renderAllStocksHeader(ctx);

    for (const s of result.allStocks) {
      const pageBefore = ctx.page;
      ensureSpace(ctx, 13);
      if (ctx.page !== pageBefore) {
        renderAllStocksHeader(ctx);
      }
      let x = MARGIN;
      const t = s.technicals;
      const rsiVal = t?.rsi14 ?? s.rsi14;
      const macdVal = t?.macdHistogram != null
        ? `${t.macdHistogram >= 0 ? "+" : ""}${t.macdHistogram.toFixed(1)}`
        : "-";
      const scoreVal = s.indicators?.screenScore != null ? String(s.indicators.screenScore) : "-";
      const cells: Array<[string, number]> = [
        [s.symbol, 50],
        [cleanForPdf(s.companyName || "").slice(0, 15), 85],
        [`$${fmt(s.lastPrice, 2)}`, 45],
        [`${s.changePercent >= 0 ? "+" : ""}${fmt(s.changePercent, 1, "%")}`, 40],
        [gapLabel(t), 42],
        [cleanForPdf((s.indicators?.sentiment ?? "neutral").replace(/_/g, " ")).slice(0, 10), 55],
        [cleanForPdf(s.factorGrades?.quantRating ?? "-").slice(0, 11), 58],
        [s.factorGrades?.value ?? "-", 24],
        [s.factorGrades?.momentum ?? "-", 24],
        [rsiVal != null ? fmt(rsiVal, 1) : "-", 38],
        [macdVal, 44],
        [scoreVal, 35],
      ];
      for (const [val, w] of cells) {
        ctx.page.drawText(cleanForPdf(val).slice(0, 16), { x, y: ctx.y, size: 8, font, color: rgb(...PRINT_INK) });
        x += w;
      }
      ctx.y -= 11;
    }
    rule(ctx);
  }

  // Methodology footer
  ensureSpace(ctx, 60);
  text(ctx, "Methodology", { size: 10, bold: true });
  const notes = [
    prov.methodologyQuotes,
    ...(prov.technicalsNote ? [prov.technicalsNote] : []),
    "RSI(14), MACD(12,26,9), gaps: Yahoo Finance daily history (complement).",
    "Factor grades (Value/Momentum A+..F): percentile-relative within this run's universe.",
    "Sentiment: day-action based (very bearish -> very bullish). Range zones are 52-week based, not RSI.",
  ];
  for (const n of notes) text(ctx, `* ${n}`, { size: 7.5, color: PRINT_NOTE });

  // Page numbers across all pages
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PAGE_W - MARGIN - 60,
      y: 20,
      size: 8,
      font,
      color: rgb(...PRINT_FAINT),
    });
  });

  return doc.save();
}

export function screenerPdfFileName(result: ScreenerRunResult): string {
  // Issue #297: Include full timestamp (not just date) to ensure uniqueness.
  // Format: market-screen_{universe}_hourly-{mm}_{timestamp}_{jobId}.pdf
  // The schedule and jobId are appended by the caller when available.
  const ts = new Date(result.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const u = (result.universe || "NASDAQ100").toLowerCase().replace(/_/g, "-");
  const schedule = (result as any).schedule || result.trigger;
  const jobId = (result as any).jobId || "adhoc";
  return `market-screen_${u}_${schedule}_${ts}_${jobId}.pdf`;
}
