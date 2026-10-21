/**
 * Options scanner PDF reports (issue #350).
 *
 * Generates an options research report PDF with pdf-lib (pure JS, Workers-compatible).
 * Used by:
 *   - the scheduled tick → Slack file upload + email attachment
 *   - the manual run → downloadable via API
 *
 * Mirrors the structure of screenerReportPdf.ts for stock screeners.
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../types";


/** Print palette (#473): named print mirrors of the semantic text roles —
 *  same scale as screenerReportPdf — instead of scattered rgb literals. */
const PRINT_INK: [number, number, number] = [0.15, 0.15, 0.15];
const PRINT_MUTED: [number, number, number] = [0.4, 0.4, 0.4];
const PRINT_NOTE: [number, number, number] = [0.45, 0.45, 0.45];
const PRINT_FAINT: [number, number, number] = [0.5, 0.5, 0.5];
const PRINT_HAIRLINE: [number, number, number] = [0.7, 0.7, 0.7];

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

function cleanForPdf(str: string): string {
  return String(str ?? "")
    .replace(/Δ/g, "Delta ")
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
  ensureSpace(ctx, size + 4);
  const c = opts.color ?? PRINT_INK;
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
    color: rgb(...PRINT_HAIRLINE),
  });
  ctx.y -= 10;
}

function formatContract(c: ScreenedOptionContractItem): string {
  const parts: string[] = [];
  parts.push(c.underlyingSymbol || c.symbol || "N/A");
  if (c.expirationDate) parts.push(c.expirationDate);
  if (c.strikePrice) parts.push(`$${c.strikePrice}`);
  if (c.optionType) parts.push(c.optionType);
  if (c.delta !== undefined) parts.push(`d${c.delta.toFixed(2)}`);
  if (c.impliedVolatility !== undefined) parts.push(`IV${(c.impliedVolatility * 100).toFixed(0)}%`);
  return parts.join(" ");
}

/**
 * Generate a PDF report for an options scan result.
 */
export async function generateOptionsPdf(result: OptionScreenResult | any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const scannedAt = result.scannedAt || result.generatedAt || result.timestamp || new Date().toISOString();
  const underlyingsScanned = result.totalUnderlyingsScanned ?? result.scanned ?? 0;
  const contractsEvaluated = result.totalContractsEvaluated ?? result.withTrades ?? 0;
  const matched = result.matchedCount ?? (result.contracts ? result.contracts.length : (result.opportunities ? result.opportunities.length : 0));
  const thesis = result.thesis || (result.mode ? String(result.mode) : "Bullish");
  const riskProfile = result.riskProfile || "Balanced";
  const universeLabel = (result.universe || (result.symbols && result.symbols.length > 0 ? result.symbols.slice(0, 5).join(", ") : "Options Universe")).replace(/_/g, " ");

  // Header
  text(ctx, `Options Scanner Report — ${universeLabel}`, { size: 16, bold: true });
  text(ctx, `Thesis: ${thesis.toUpperCase()}  •  Risk Profile: ${riskProfile}  •  Generated: ${scannedAt}`, { size: 9, color: PRINT_MUTED });

  // Active Criteria Box
  ensureSpace(ctx, 16);
  const activeCriteria = result.filterSummary || `Thesis ${thesis}, risk profile ${riskProfile}, live E*TRADE chains`;
  text(ctx, `Active Criteria: ${activeCriteria}`, { size: 9, bold: true, color: PRINT_INK });
  rule(ctx);

  // Summary
  text(ctx, "Summary", { size: 12, bold: true });
  text(ctx, `Underlyings scanned: ${underlyingsScanned}   Contracts evaluated: ${contractsEvaluated}   Matched: ${matched}`);
  rule(ctx);

  // Contracts or Opportunities
  if (Array.isArray(result.contracts) && result.contracts.length > 0) {
    text(ctx, `Matched Contracts (${result.contracts.length})`, { size: 12, bold: true });
    ctx.y -= 4;

    for (const contract of result.contracts.slice(0, 50)) {
      ensureSpace(ctx, 28);
      text(ctx, formatContract(contract), { size: 9, bold: true });
      if (contract.bid && contract.ask) {
        text(ctx, `  Bid/Ask: $${contract.bid.toFixed(2)} / $${contract.ask.toFixed(2)}`, { size: 8, color: PRINT_MUTED });
      }
      ctx.y -= 2;
    }

    if (result.contracts.length > 50) {
      text(ctx, `... and ${result.contracts.length - 50} more`, { size: 9, color: PRINT_FAINT });
    }
    rule(ctx);
  } else if (Array.isArray(result.opportunities) && result.opportunities.length > 0) {
    text(ctx, `Opportunities (${result.opportunities.length})`, { size: 12, bold: true });
    ctx.y -= 4;

    for (const opp of result.opportunities.slice(0, 50)) {
      ensureSpace(ctx, 28);
      const symbol = opp.symbol || "N/A";
      const pick = opp.pick;
      const pickName = pick?.strategyName || pick?.strategyType || "Strategy";
      const price = opp.underlyingPrice !== undefined ? `$${opp.underlyingPrice.toFixed(2)}` : "";
      const score = opp.score !== undefined ? `Score: ${opp.score}` : "";
      const bucket = opp.gateBucket ? `[${String(opp.gateBucket).toUpperCase()}]` : "";
      text(ctx, `${symbol} - ${pickName} ${price} ${bucket}`.trim(), { size: 9, bold: true });
      const detail = pick?.description || pick?.reasoning || score;
      if (detail) {
        text(ctx, `  ${detail}`, { size: 8, color: PRINT_MUTED });
      }
      ctx.y -= 2;
    }

    if (result.opportunities.length > 50) {
      text(ctx, `... and ${result.opportunities.length - 50} more`, { size: 9, color: PRINT_FAINT });
    }
    rule(ctx);
  } else {
    text(ctx, "No matching contracts or opportunities found.", { size: 10, color: PRINT_MUTED });
    rule(ctx);
  }

  // Methodology footer
  ensureSpace(ctx, 40);
  text(ctx, "Methodology", { size: 10, bold: true });
  text(ctx, "* Quotes: E*TRADE live option chains. Standard Greeks via Black-Scholes.", { size: 7.5, color: PRINT_NOTE });
  text(ctx, "* Multi-leg strategy discovery: risk-bounded payoff evaluations per defined risk profile.", { size: 7.5, color: PRINT_NOTE });

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

  return (await doc.save()) as Uint8Array;
}

/**
 * Generate a filename for the options PDF report.
 */
/**
 * #297 naming parity with the stock screener PDFs (#334):
 * options-scan_{universe}_{schedule}_{timestamp}_{jobId}.pdf
 * The schedule and jobId are appended by the caller when available.
 */
export function optionsPdfFileName(result: OptionScreenResult | any): string {
  const dateStr = result.scannedAt || result.generatedAt || result.timestamp || new Date().toISOString();
  let ts: string;
  try {
    ts = new Date(dateStr).toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  } catch {
    ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  }
  const r = result as unknown as Record<string, unknown>;
  const u = String(r.universe || "options").toLowerCase().replace(/_/g, "-");
  const schedule = String(r.schedule || r.trigger || "adhoc");
  const jobId = String(r.jobId || "adhoc");
  return `options-scan_${u}_${schedule}_${ts}_${jobId}.pdf`;
}
