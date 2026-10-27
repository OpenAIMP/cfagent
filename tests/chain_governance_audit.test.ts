/**
 * Issue #1468 ([AGENTIC] Phase 6, sub-issue of #1362) — delegation pins,
 * as migrated by #1747 (branch 2: chain-native promotion authority).
 *
 * Each behavior must delegate to shipped code; these tests drive the
 * REAL shipped functions through a fake D1 sql shim (same pattern as
 * tests/adaptation_audit.test.ts):
 *  - Promotion: a REAL Phase 3 approval — a record synthesized from
 *    the same compiled chain and approved via
 *    `approveSynthesizedRecord` — is what `promoteChainVersion`
 *    consumes. No #759 verdict is involved.
 *  - Audit: the REAL #755 `recordAdaptation` writes the row that
 *    `recordChainRunAudit` returns, readable via `listAdaptationAudit`.
 *  - Kill: the REAL #756 `isAdaptationHalted` is the global halt that
 *    `isGovernedHalted` exposes.
 */
import { describe, it, expect } from "vitest";
import { compileGoal } from "../src/orchestrate";
import {
  synthesizeSchedule,
  approveSynthesizedRecord,
} from "../src/agentic/jobSynthesis";
import {
  listAdaptationAudit,
  isAdaptationHalted,
} from "../src/services/adaptationAudit";
import {
  versionChain,
  promoteChainVersion,
  isGovernedHalted,
  attributeChainRun,
  recordChainRunAudit,
} from "../src/agentic/chainGovernance";

/** Minimal fake D1 sql: generic INSERT parsing + per-table SELECT/UPDATE. */
function makeFakeSql() {
  const tables: Record<string, any[]> = {
    mas_adaptation_audit: [],
  };
  const settings = new Map<string, string>();
  const insert = (rows: any[], text: string, params: any[]) => {
    const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1].split(",").map((c) => c.trim());
    const valuesPart = /VALUES\s*\((.*)\)\s*$/is.exec(text)![1];
    const tokens: string[] = [];
    let cur = "";
    let inQuote = false;
    for (const ch of valuesPart) {
      if (ch === "'") inQuote = !inQuote;
      if (ch === "," && !inQuote) {
        tokens.push(cur);
        cur = "";
      } else cur += ch;
    }
    tokens.push(cur);
    const row: any = {};
    let argIdx = 0;
    cols.forEach((c, i) => {
      const tok = (tokens[i] ?? "?").trim();
      if (tok === "?") row[c] = params[argIdx++];
      else if (tok.startsWith("'") && tok.endsWith("'"))
        row[c] = tok.slice(1, -1).replace(/''/g, "'");
      else if (tok.toUpperCase() === "NULL") row[c] = null;
      else if (!Number.isNaN(Number(tok))) row[c] = Number(tok);
      else row[c] = params[argIdx++];
    });
    rows.push(row);
  };
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/FROM mas_settings/i.test(text)) {
        const v = settings.get(params[0]);
        return v === undefined ? [] : [{ value: v }];
      }
      const tableName = Object.keys(tables).find((t) => text.includes(t));
      if (!tableName) return [];
      const rows = tables[tableName];
      if (/^\s*INSERT/i.test(text)) {
        insert(rows, text, params);
        return [];
      }
      if (/FROM mas_adaptation_audit/i.test(text)) {
        let out = [...rows];
        if (/subject = \?/.test(text)) out = out.filter((r) => r.subject === params[0]);
        out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const lim = /LIMIT (\d+)/.exec(text);
        if (lim) out = out.slice(0, Number(lim[1]));
        return out.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, tables, settings };
}

describe("promotion consumes a REAL Phase 3 approval (#1747)", () => {
  it("an approved record for this chain's content promotes draft → shadow and records the authority", () => {
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    if (!chain) throw new Error("test chain did not compile");
    const version = versionChain("chain-nasdaq-slack", chain, 1);
    // The approval is a REAL Phase 3 record: synthesized from the same
    // compiled chain, approved via the shipped confirmation transition.
    // Its steps match the version's steps — that match is the binding.
    const pending = synthesizeSchedule(chain, { id: "synth-audit-1", cron: "0 6 * * *" });
    const approval = approveSynthesizedRecord(pending, "2026-10-25T01:00:00.000Z");
    expect(approval.status).toBe("approved");
    expect(approval.steps.map((s) => s.capabilityId)).toEqual(
      version.steps.map((s) => s.capabilityId),
    );
    const promoted = promoteChainVersion(version, approval);
    expect(promoted.stage).toBe("shadow");
    expect(promoted.authorityRef).toBe(approval.id);
  });

  it("without any approval, promotion refuses even though the chain exists", () => {
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    const pending = synthesizeSchedule(chain, { id: "synth-audit-pending", cron: "0 6 * * *" });
    expect(() =>
      promoteChainVersion(versionChain("chain-ungated", chain, 1), pending),
    ).toThrow(/not approved/);
  });
});

describe("audit + kill delegate to shipped #755/#756 code (#1468)", () => {
  it("recordChainRunAudit writes a REAL #755 audit row readable via listAdaptationAudit", () => {
    const { sql } = makeFakeSql();
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
    });
    if (!chain) throw new Error("test chain did not compile");
    const version = versionChain("chain-nasdaq-slack", chain, 1);
    const attr = attributeChainRun(version, {
      goal: chain.goal,
      shardProvenance: ["shard-feed-1", "shard-generate-1"],
      outcome: "completed",
      runAt: "2026-10-26T06:00:00.000Z",
    });
    const auditId = recordChainRunAudit(sql, attr, new Date("2026-10-26T06:00:00.000Z"));
    expect(typeof auditId).toBe("string");
    const rows = listAdaptationAudit(sql, "chain-nasdaq-slack");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(auditId);
    expect(rows[0].parameter).toBe("chain-version:1");
    expect(rows[0].status).toBe("applied");
    expect(rows[0].dataWindow).toBe("shard-feed-1,shard-generate-1");
    expect(rows[0].after).toContain("completed");
  });

  it("isGovernedHalted IS the shipped #756 switch: on halts, off/unknown does not", () => {
    const { sql, settings } = makeFakeSql();
    expect(isGovernedHalted(sql)).toBe(false);
    expect(isGovernedHalted(sql)).toBe(isAdaptationHalted(sql));
    settings.set("adaptation.killSwitch", "on");
    expect(isGovernedHalted(sql)).toBe(true);
    expect(isAdaptationHalted(sql)).toBe(true);
    settings.set("adaptation.killSwitch", "off");
    expect(isGovernedHalted(sql)).toBe(false);
  });
});
