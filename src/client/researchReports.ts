import * as XLSX from "@e965/xlsx";

export interface ResearchReportSheet {
  name: string;
  rows: Array<Record<string, unknown>>;
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export async function createResearchWorkbook(sheets: ResearchReportSheet[]): Promise<Uint8Array> {
  if (sheets.length === 0) throw new Error("There is no research data to export.");

  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const rows = sheet.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCell(value)]))
    );
    const worksheet = rows.length > 0
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.aoa_to_sheet([["No rows available"]]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "array" }));
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
