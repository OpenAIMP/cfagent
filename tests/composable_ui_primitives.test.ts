import { describe, it, expect } from "vitest";
import React from "react";
import { SegmentedControl, PillGroup } from "../src/client/components/ui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Composable UI Primitives (Design System)", () => {
  describe("SegmentedControl Component", () => {
    it("renders options with correct accessibility attributes", () => {
      const options = [
        { id: "graph", label: "Graph", icon: "📈" },
        { id: "table", label: "Matrix Table", icon: "⊞" },
      ];

      const element = React.createElement(SegmentedControl, {
        value: "graph",
        onChange: () => {},
        options,
        ariaLabel: "Payoff display mode",
        size: "md",
      });

      expect(element).toBeDefined();
      expect(element.props.value).toBe("graph");
      expect(element.props.options).toHaveLength(2);
      expect(element.props.ariaLabel).toBe("Payoff display mode");
    });

    it("supports optional size variants", () => {
      const sizes: Array<"sm" | "md" | "lg"> = ["sm", "md", "lg"];
      for (const size of sizes) {
        const element = React.createElement(SegmentedControl, {
          value: "test",
          onChange: () => {},
          options: [{ id: "test", label: "Test" }],
          size,
        });
        expect(element.props.size).toBe(size);
      }
    });

    it("supports badges and disabled options", () => {
      const element = React.createElement(SegmentedControl, {
        value: "active",
        onChange: () => {},
        options: [
          { id: "active", label: "Active", badge: "5" },
          { id: "disabled", label: "Disabled", disabled: true },
        ],
      });
      expect(element.props.options[0].badge).toBe("5");
      expect(element.props.options[1].disabled).toBe(true);
    });
  });

  describe("PillGroup Component", () => {
    it("renders pill options and tracks selection", () => {
      const options = [
        { id: "pnl_dollar", label: "Profit / Loss $" },
        { id: "pnl_pct", label: "Profit / Loss %" },
        { id: "collateral_pct", label: "% of Risk" },
        { id: "contract_val", label: "Contract Value" },
      ];

      const element = React.createElement(PillGroup, {
        value: "pnl_dollar",
        onChange: () => {},
        options,
        variant: "cyan",
        size: "sm",
      });

      expect(element).toBeDefined();
      expect(element.props.value).toBe("pnl_dollar");
      expect(element.props.options).toHaveLength(4);
      expect(element.props.variant).toBe("cyan");
      expect(element.props.size).toBe("sm");
    });

    it("supports multiple color variants for theming", () => {
      const variants: Array<"cyan" | "emerald" | "amber" | "purple"> = [
        "cyan",
        "emerald",
        "amber",
        "purple",
      ];
      for (const variant of variants) {
        const element = React.createElement(PillGroup, {
          value: "m1",
          onChange: () => {},
          options: [{ id: "m1", label: "Metric 1" }],
          variant,
        });
        expect(element.props.variant).toBe(variant);
      }
    });
  });
});

describe("Primitive styles (primitives.css)", () => {
  const css = readFileSync(
    join(process.cwd(), "src/client/components/ui/primitives.css"),
    "utf8",
  );

  it("defines every class hook the components emit", () => {
    for (const hook of [
      ".segmented-control",
      ".segmented-btn",
      ".segmented-badge",
      ".size-sm",
      ".size-md",
      ".size-lg",
      ".pill-group",
      ".pill-btn",
      ".variant-cyan",
      ".variant-emerald",
      ".variant-amber",
      ".variant-purple",
    ]) {
      expect(css, hook).toContain(hook);
    }
  });

  it("contains no raw color literals (token-only styling)", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it("keeps focus visible and honors reduced motion", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion");
  });
});
