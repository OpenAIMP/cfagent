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

function formatContract(c: ScreenedOptionContractItem): string {
  const parts: string[] = [];
  parts.push(c.underlyingSymbol || c.symbol || "N/A");
  if (c.expirationDate) parts.push(c.expirationDate);
  if (c.strikePrice) parts.push(`$${c.strikePrice}`);
  if (c.optionType) parts.push(c.optionType);
  if (c.delta !== undefined) parts.push(`Δ${c.delta.toFixed(2)}`);
  if (c.impliedVolatility !== undefined) parts.push(`IV${(c.impliedVolatility * 100).toFixed(0)}%`);
  return parts.join(" ");
}

/**
 * Generate a PDF report for an options scan result.
 */
export async function generateOptionsPdf(result: OptionScreenResult): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  // Header
  text(ctx, "Options Scanner Report", { size: 18, bold: true });
  text(ctx, `Generated: ${result.scannedAt}`, { size: 9, color: [0.4, 0.4, 0.4] });
  rule(ctx);

  // Summary
  text(ctx, "Summary", { size: 14, bold: true });
  text(ctx, `Underlyings scanned: ${result.totalUnderlyingsScanned}`);
  text(ctx, `Contracts evaluated: ${result.totalContractsEvaluated}`);
  text(ctx, `Matched: ${result.matchedCount}`);
  if (result.filterSummary) {
    text(ctx, `Filter: ${result.filterSummary}`, { size: 9 });
  }
  rule(ctx);

  // Contracts
  text(ctx, `Matched Contracts (${result.contracts.length})`, { size: 14, bold: true });
  ctx.y -= 4;

  for (const contract of result.contracts.slice(0, 50)) {
    ensureSpace(ctx, 28);
    text(ctx, formatContract(contract), { size: 9, bold: true });
    if (contract.bid && contract.ask) {
      text(ctx, `  Bid/Ask: $${contract.bid.toFixed(2)} / $${contract.ask.toFixed(2)}`, { size: 8, color: [0.4, 0.4, 0.4] });
    }
    ctx.y -= 2;
  }

  if (result.contracts.length > 50) {
    text(ctx, `... and ${result.contracts.length - 50} more`, { size: 9, color: [0.5, 0.5, 0.5] });
  }

  return await doc.save() as Uint8Array;
}

/**
 * Generate a filename for the options PDF report.
 */
export function optionsPdfFileName(result: OptionScreenResult): string {
  const date = result.scannedAt.slice(0, 10);
  const time = result.scannedAt.slice(11, 19).replace(/:/g, "-");
  return `options-scan_${date}_${time}.pdf`;
}
