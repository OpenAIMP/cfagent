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

const MARGIN = 48;
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

function text(
  ctx: Ctx,
  str: string,
  opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number } = {}
): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  ensureSpace(ctx, size + 4);
  const c = opts.color ?? [0.15, 0.15, 0.15];
  ctx.page.drawText(str.slice(0, 120), {
    x: opts.x ?? MARGIN,
    y: ctx.y,
    size,
    font,
    color: rgb(c[0], c[1], c[2]),
  });
  ctx.y -= size + 4;
}

function rule(ctx: Ctx): void {
  ensureSpace(ctx, 10);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.75,
    color: rgb(0.7, 0.7, 0.7),
  });
  ctx.y -= 10;
}

function fmt(n: number | null | undefined, digits = 2, suffix = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function gapLabel(t: { gapPercent: number | null; gapDirection: string | null }): string {
  if (t.gapPercent == null) return "—";
  const arrow = t.gapDirection === "up" ? "▲" : t.gapDirection === "down" ? "▼" : "•";
  return `${arrow} ${t.gapPercent >= 0 ? "+" : ""}${t.gapPercent.toFixed(2)}%`;
}

export async function generateScreenerPdf(
  result: ScreenerRunResult
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const triggerLabel = result.trigger === "manual" ? "Manual Screen" : "Autonomous Screen";

  // Header
  text(ctx, "Stock Screener Report", { size: 18, bold: true });
  text(ctx, `${triggerLabel}  •  ${result.sector} sector`, { size: 11, color: [0.4, 0.4, 0.4] });
  text(ctx, new Date(result.timestamp).toLocaleString(), { size: 10, color: [0.4, 0.4, 0.4] });
  rule(ctx);

  if (!result.success) {
    text(ctx, "Screen failed", { size: 13, bold: true, color: [0.8, 0.2, 0.2] });
    text(ctx, result.error || "E*TRADE unavailable — no market data.", { size: 10 });
    return doc.save();
  }

  // Summary
  text(ctx, "Summary", { size: 13, bold: true });
  text(ctx, `Scanned: ${result.totalScanned}   Matched: ${result.matchedCount}   Opportunities: ${result.opportunities.length}`);
  if (result.discoveryMessage) text(ctx, result.discoveryMessage, { size: 9, color: [0.4, 0.4, 0.4] });
  rule(ctx);

  // Gaps summary
  const gappers = (result.allStocks || [])
    .filter((s) => s.technicals?.gapPercent != null)
    .sort((a, b) => Math.abs(b.technicals.gapPercent!) - Math.abs(a.technicals.gapPercent!))
    .slice(0, 8);
  const gapUps = gappers.filter((s) => s.technicals.gapDirection === "up");
  const gapDowns = gappers.filter((s) => s.technicals.gapDirection === "down");
  if (gappers.length > 0) {
    text(ctx, `Top gaps  (up: ${gapUps.length}   down: ${gapDowns.length})`, { size: 13, bold: true });
    for (const s of gappers) {
      text(ctx, `${s.symbol}  ${gapLabel(s.technicals)}  @ $${fmt(s.lastPrice)}`, { size: 10 });
    }
    rule(ctx);
  }

  // Opportunities
  text(ctx, "Opportunities", { size: 13, bold: true });
  if (result.opportunities.length === 0) {
    text(ctx, "No standout opportunities in this run.", { size: 10, color: [0.4, 0.4, 0.4] });
  } else {
    // Header row
    const cols: Array<[string, number]> = [
      ["Symbol", 62], ["Quant", 78], ["Val", 34], ["Mom", 38],
      ["Sentiment", 84], ["Price", 62], ["Chg%", 56], ["Gap%", 62], ["RSI", 44],
    ];
    ensureSpace(ctx, 16);
    let x = MARGIN;
    for (const [label, w] of cols) {
      ctx.page.drawText(label, { x, y: ctx.y, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) });
      x += w;
    }
    ctx.y -= 13;
    for (const o of result.opportunities) {
      ensureSpace(ctx, 14);
      x = MARGIN;
      const t = o.technicals;
      const cells: Array<[string, number]> = [
        [o.symbol, 62],
        [o.factorGrades?.quantRating ?? "—", 78],
        [o.factorGrades?.value ?? "—", 34],
        [o.factorGrades?.momentum ?? "—", 38],
        [(o.indicators?.sentiment ?? "neutral").replace(/_/g, " "), 84],
        [`$${fmt(o.lastPrice)}`, 62],
        [`${o.changePercent >= 0 ? "+" : ""}${fmt(o.changePercent, 2, "%")}`, 56],
        [gapLabel(t), 62],
        [fmt(t?.rsi14, 1), 44],
      ];
      for (const [val, w] of cells) {
        ctx.page.drawText(val.slice(0, 18), { x, y: ctx.y, size: 9, font, color: rgb(0.15, 0.15, 0.15) });
        x += w;
      }
      ctx.y -= 12;
    }
    rule(ctx);
  }

  // Methodology footer
  text(ctx, "Methodology", { size: 11, bold: true });
  const notes = [
    "Quotes: E*TRADE live snapshots (primary). No fallback data substituted.",
    "RSI(14), MACD(12,26,9), gaps: Yahoo Finance daily history (complement).",
    "Factor grades (Value/Momentum A+..F): percentile-relative within this run's universe.",
    "Growth/Profitability/Revisions: withheld — E*TRADE carries no fundamentals.",
    "Sentiment: day-action based (very bearish → very bullish). Range zones are 52-week based, not RSI.",
  ];
  for (const n of notes) text(ctx, `• ${n}`, { size: 8, color: [0.45, 0.45, 0.45] });

  // Page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Page ${i + 1} of ${pages.length}`, {
      x: PAGE_W - MARGIN - 70,
      y: 28,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });
  });

  return doc.save();
}

export function screenerPdfFileName(result: ScreenerRunResult): string {
  const d = new Date(result.timestamp).toISOString().slice(0, 10);
  return `screener-${result.trigger}-${d}.pdf`;
}
