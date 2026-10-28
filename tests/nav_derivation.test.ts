/**
 * Shell derivation contract (#1804 S1, issue #1808): NAVIGATION_ITEMS,
 * isTabActive, and the visibility defaults all derive from the route
 * table, reproducing the historical nav exactly — same 24 items, same
 * display order, same active-state groups.
 * (#2120 slice 1 added the Search nav entry, navOrder 23, last in
 * display order; pin updated in the same PR per the §7 pin rule.)
 */
import { describe, it, expect } from "vitest";
import {
  NAVIGATION_ITEMS,
  isTabActive,
  DEFAULT_VISIBLE_NAV_TABS,
} from "../src/client/components/NavigationMenu";

const EXPECTED_ORDER = [
  "autopilot",
  "order",
  "portfolio",
  "ledger",
  "approvals",
  "options-flows",
  "screeners",
  "research",
  "chat",
  "voice",
  "omnichannel",
  "workflows",
  "workflow-runs",
  "endpoints",
  "nlq",
  "audit",
  "payments",
  "referrals",
  "ads",
  "revenue",
  "social",
  "payment-assurance",
  "docs",
  "search",
];

describe("nav derivation", () => {
  it("derives the 24 nav items in display order", () => {
    expect(NAVIGATION_ITEMS.map((i) => i.id)).toEqual(EXPECTED_ORDER);
  });

  it("every derived item carries label, shortLabel, category, icon, description", () => {
    for (const item of NAVIGATION_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.shortLabel.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(["Execution", "Intelligence", "Playbooks", "Platform"]).toContain(item.category);
      expect(typeof item.icon).toBe("function");
    }
  });

  it("spot-checks historical nav labels", () => {
    const byId = new Map(NAVIGATION_ITEMS.map((i) => [i.id, i]));
    expect(byId.get("autopilot")!.label).toBe("Autopilot Control");
    expect(byId.get("order")!.label).toBe("Fast Order Ticket");
    expect(byId.get("screeners")!.label).toBe("Screening");
    expect(byId.get("social")!.label).toBe("Social Posting");
    expect(byId.get("approvals")!.label).toBe("Approvals");
    expect(byId.get("docs")!.label).toBe("Docs and Reports");
  });

  it("active states follow nav groups, not hand-coded cases", () => {
    expect(isTabActive("autopilot", "autopilot")).toBe(true);
    expect(isTabActive("autopilot", "trading")).toBe(true);
    expect(isTabActive("order", "orders")).toBe(true);
    expect(isTabActive("screeners", "scanner")).toBe(true);
    expect(isTabActive("screeners", "options")).toBe(true);
    expect(isTabActive("screeners", "reports")).toBe(true);
    expect(isTabActive("screeners", "schedules")).toBe(true);
    expect(isTabActive("portfolio", "portfolio")).toBe(true);
    expect(isTabActive("portfolio", "ledger")).toBe(false);
    expect(isTabActive("screeners", "social")).toBe(false);
  });

  it("visibility defaults come from the table", () => {
    expect(Object.keys(DEFAULT_VISIBLE_NAV_TABS).sort()).toEqual([...EXPECTED_ORDER].sort());
  });
});
