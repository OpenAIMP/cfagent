import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { createResearchWorkbook } from "../src/client/researchReports";

describe("research workbook export", () => {
  it("creates named sheets with all supplied report data", async () => {
    const bytes = await createResearchWorkbook([
      { name: "Option data", rows: [{ symbol: "NVDA", strike: 260, greeks: { delta: 0.42 } }] },
      { name: "Evaluations", rows: [{ strategy: "call debit spread", status: "accepted" }] },
      { name: "Empty", rows: [] },
    ]);
    const workbook = XLSX.read(bytes, { type: "array" });

    expect(workbook.SheetNames).toEqual(["Option data", "Evaluations", "Empty"]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets["Option data"])).toEqual([
      { symbol: "NVDA", strike: 260, greeks: '{"delta":0.42}' },
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Evaluations)).toEqual([
      { strategy: "call debit spread", status: "accepted" },
    ]);
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Empty, { header: 1 })).toEqual([["No rows available"]]);
  });

  it("rejects empty workbook exports", async () => {
    await expect(createResearchWorkbook([])).rejects.toThrow("There is no research data to export.");
  });
});
