import { describe, it, expect } from "vitest";
import { Table } from "../src/client/components/ui/Table";
import {
  matrixCellBg,
  matrixCellDisplay,
} from "../src/client/options/StrategyDiscoveryPanel";
import type { Matrix2dCell } from "../src/client/options/strategyDiscoveryEngine";

/**
 * Table function-props + payoff-matrix helpers (P1, #1835).
 * Table uses no hooks, so it is called directly and its element tree is
 * walked — the repo's DOM-free convention.
 */

type Row = { id: string; spot: boolean; val: number };

const COLUMNS = [
  {
    key: "id",
    header: "ID",
    headerClassName: "sticky-col",
    cellClassName: "sticky-col price-cell",
    render: (row: Row) => row.id,
  },
  {
    key: "val",
    header: "Value",
    cellClassName: (row: Row) => (row.val >= 0 ? "matrix-cell gain" : "matrix-cell loss"),
    cellStyle: (row: Row) => ({ background: row.val >= 0 ? "green" : "red" }),
    render: (row: Row) => String(row.val),
  },
];

const ROWS: Row[] = [
  { id: "a", spot: true, val: 5 },
  { id: "b", spot: false, val: -3 },
];

function getTable(rowClassName: string | ((row: Row) => string)) {
  // Table returns <div><table>…; walk to thead/tbody.
  const el = Table({
    columns: COLUMNS,
    rows: ROWS,
    rowKey: (row) => row.id,
    rowClassName,
  }) as unknown as { props: { children: { props: { children: unknown } } } };
  const table = el.props.children;
  const [thead, tbody] = (table.props.children as unknown[]).filter(Boolean) as Array<{
    props: { children: unknown };
  }>;
  const headRow = thead.props.children as { props: { children: unknown[] } };
  const bodyRows = (tbody.props.children as unknown[]).map(
    (tr) => tr as { props: { children: unknown[]; className?: string } },
  );
  return { headCells: headRow.props.children as Array<{ props: { className?: string } }>, bodyRows };
}

describe("Table function props (#1835)", () => {
  it("applies headerClassName to th", () => {
    const { headCells } = getTable("");
    expect(headCells[0].props.className).toContain("sticky-col");
  });

  it("computes rowClassName per row", () => {
    const { bodyRows } = getTable((row) => (row.spot ? "current-price-row" : ""));
    expect(bodyRows[0].props.className).toBe("current-price-row");
    expect(bodyRows[1].props.className).toBeUndefined();
  });

  it("keeps string rowClassName working for every row", () => {
    const { bodyRows } = getTable("always");
    expect(bodyRows[0].props.className).toBe("always");
    expect(bodyRows[1].props.className).toBe("always");
  });

  it("computes cellClassName and cellStyle per row", () => {
    const { bodyRows } = getTable("");
    const cells = (rowIdx: number) =>
      bodyRows[rowIdx].props.children as Array<{
        props: { className?: string; style?: { background?: string } };
      }>;
    expect(cells(0)[1].props.className).toContain("gain");
    expect(cells(0)[1].props.style).toEqual({ background: "green" });
    expect(cells(1)[1].props.className).toContain("loss");
    expect(cells(1)[1].props.style).toEqual({ background: "red" });
    expect(cells(0)[0].props.className).toContain("sticky-col price-cell");
  });
});

const CELL: Matrix2dCell = {
  price: 100,
  dateStr: "2026-01-01",
  dteRemaining: 5,
  pnlDollar: 250,
  pnlPercent: 25,
  riskPercent: 10,
  contractValue: 1250,
};

describe("matrixCellDisplay (#1835)", () => {
  it("formats all four metric modes with signs", () => {
    expect(matrixCellDisplay(CELL, "pnl_dollar")).toBe("+$250");
    expect(matrixCellDisplay(CELL, "pnl_pct")).toBe("+25%");
    expect(matrixCellDisplay(CELL, "collateral_pct")).toBe("+10%");
    expect(matrixCellDisplay(CELL, "contract_val")).toBe("$1,250");
    expect(matrixCellDisplay({ ...CELL, pnlDollar: -50, pnlPercent: -5 }, "pnl_dollar")).toBe("$-50");
    expect(matrixCellDisplay({ ...CELL, pnlDollar: -50, pnlPercent: -5 }, "pnl_pct")).toBe("-5%");
  });
});

describe("matrixCellBg (#1835)", () => {
  it("shades gains green, losses red, zero muted", () => {
    expect(matrixCellBg(CELL, 1000, -1000)).toContain("var(--color-success)");
    expect(matrixCellBg({ ...CELL, pnlDollar: -100 }, 1000, -1000)).toContain("var(--color-danger)");
    expect(matrixCellBg({ ...CELL, pnlDollar: 0 }, 1000, -1000)).toBe("var(--color-muted)");
  });

  it("caps intensity at 70%", () => {
    expect(matrixCellBg({ ...CELL, pnlDollar: 100000 }, 1000, -1000)).toContain("70%");
  });
});
