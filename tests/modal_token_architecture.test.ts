import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Universal Modal System & Diagnostics Token Architecture", () => {
  const tokensCss = fs.readFileSync(path.resolve("src/client/tokens.css"), "utf8");
  const stylesCss = fs.readFileSync(path.resolve("src/client/styles.css"), "utf8");
  const tradingHub = fs.readFileSync(path.resolve("src/client/ETradeTradingHub.tsx"), "utf8");

  describe("Section 5: Universal Modal System in tokens.css", () => {
    it("defines universal modal card containers using design tokens", () => {
      expect(tokensCss).toContain(".modal-dialog");
      expect(tokensCss).toContain(".etrade-pin-modal");
      expect(tokensCss).toContain(".diagnostics-modal");
      expect(tokensCss).toContain(".quote-modal-content");
      expect(tokensCss).toContain("var(--color-surface-raised");
    });

    it("enforces light mode surface elevation on modal dialogs and backdrops", () => {
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal');
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal');
      expect(tokensCss).toContain('[data-theme="light"] .quote-modal-content');
      expect(tokensCss).toContain("background: #ffffff !important");
      expect(tokensCss).toContain("border-color: #e2e8f0 !important");
      expect(tokensCss).toContain("color: #0f172a !important");
    });

    it("tokenizes modal headers and close/cancel buttons for both themes", () => {
      expect(tokensCss).toContain(".modal-header");
      expect(tokensCss).toContain('[data-theme="light"] .modal-header');
      expect(tokensCss).toContain(".btn-close-modal");
      expect(tokensCss).toContain('[data-theme="light"] .btn-close-modal');
      expect(tokensCss).toContain(".btn-cancel-modal");
      expect(tokensCss).toContain('[data-theme="light"] .btn-cancel-modal');
    });

    it("tokenizes E*TRADE OAuth PIN modal instructions, badges, inputs, and action buttons in light mode", () => {
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal .step-instruction');
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal .step-number');
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal .btn-open-etrade');
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal .pin-input');
      expect(tokensCss).toContain('[data-theme="light"] .etrade-pin-modal .btn-submit-pin');
      expect(tokensCss).toContain("background: #ecfdf5 !important");
      expect(tokensCss).toContain("color: #059669 !important");
    });
  });

  describe("Section 6: E*TRADE Live REST Diagnostics Modal Token Alignment", () => {
    it("defines high contrast tokens for diagnostic credentials cards in light mode", () => {
      expect(tokensCss).toContain(".diagnostics-modal .diag-card");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .diag-card');
      expect(tokensCss).toContain(".diagnostics-modal .diag-label");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .diag-label');
      expect(tokensCss).toContain(".diagnostics-modal .diag-val");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .diag-val');
    });

    it("styles diagnostic error banners and technical drawer to prevent jarring contrast mismatches", () => {
      expect(tokensCss).toContain(".diagnostics-modal .diag-error-box");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .diag-error-box');
      expect(tokensCss).toContain(".diagnostics-modal .diagnostics-drawer");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .diagnostics-drawer');
      expect(tokensCss).toContain(".diagnostics-modal details.diag-raw-box");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal details.diag-raw-box');
    });

    it("provides light and dark variants for status pills and action buttons", () => {
      expect(tokensCss).toContain(".diagnostics-modal .status-pill");
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .status-error');
      expect(tokensCss).toContain('[data-theme="light"] .diagnostics-modal .status-healthy');
      expect(tokensCss).toContain(".diagnostics-modal .diag-modal-actions");
    });
  });

  describe("styles.css Deference to Design Tokens", () => {
    it("does not hardcode dark background on .etrade-pin-modal", () => {
      const pinModalMatch = stylesCss.match(/\.etrade-pin-modal\s*\{([^}]+)\}/);
      expect(pinModalMatch).not.toBeNull();
      const pinModalBody = pinModalMatch![1];
      expect(pinModalBody).not.toContain("background: #0f172a;");
      expect(pinModalBody).toContain("var(--color-surface-raised");
    });

    it("does not apply hardcoded white card override to .diagnostics-drawer inside styles.css", () => {
      const drawerOverride = stylesCss.match(/\[data-theme="light"\]\s*\.diagnostics-drawer/);
      expect(drawerOverride).toBeNull();
    });
  });

  describe("ETradeTradingHub.tsx JSX Token Architecture", () => {
    it("uses semantic diagnostic classes rather than ad-hoc inline styles", () => {
      expect(tradingHub).toContain('className="diag-card"');
      expect(tradingHub).toContain('className="diag-label"');
      expect(tradingHub).toContain('className="diag-val');
      expect(tradingHub).toContain('className="diag-error-box"');
      expect(tradingHub).toContain('className="diag-raw-box"');
      expect(tradingHub).toContain('className="diag-modal-actions"');
    });
  });

  describe("Section 7: Strategy Discovery & Payoff Analyzer Top Buttons Token Architecture", () => {
    const stratCss = fs.readFileSync(path.resolve("src/client/options/strategyDiscovery.css"), "utf8");

    it("standardizes top button heights, typography, and border radius across both rows", () => {
      expect(tokensCss).toContain(".strat-view-tab-btn");
      expect(tokensCss).toContain(".strat-action-chip");
      expect(tokensCss).toContain(".strat-btn-action");
      expect(tokensCss).toContain(".options-download-main-btn");
      expect(tokensCss).toContain("height: 32px");
      expect(tokensCss).toContain("min-height: 32px");
      expect(tokensCss).toContain("border-radius: var(--radius-sm, 6px)");
    });

    it("ensures the trade button is vibrant and high-contrast in light mode", () => {
      expect(tokensCss).toContain('[data-theme="light"] .strat-action-chip.trade-fast');
      expect(stratCss).toContain('[data-theme="light"] .strat-action-chip.trade-fast');
      expect(stylesCss).toContain('[data-theme="light"] .strat-action-chip.trade-fast');
      expect(stratCss).toContain("background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%) !important");
      expect(stratCss).toContain("color: #ffffff !important");
    });

    it("uses semantic border tokens instead of text-color tokens in light theme", () => {
      // In light theme, borders must use border tokens, not text tokens
      expect(stratCss).toContain('[data-theme="light"] .strat-view-tabs');
      expect(stratCss).toContain("border-bottom-color: var(--color-border-subtle)");
      expect(stratCss).not.toContain('[data-theme="light"] .strat-view-tabs,\nbody.theme-light .strat-view-tabs {\n  border-bottom-color: var(--color-text-secondary);');
    });

    it("provides explicit light mode high-contrast styles for secondary actions", () => {
      expect(stratCss).toContain('[data-theme="light"] .strat-action-chip.highlight');
      expect(stratCss).toContain('[data-theme="light"] .strat-action-chip.save');
      expect(stratCss).toContain('[data-theme="light"] .strat-btn-action.eval-llm');
      expect(stratCss).toContain('[data-theme="light"] .strat-btn-action.risk-btn');
      expect(stratCss).toContain('[data-theme="light"] .options-download-main-btn');
    });

    it("structures Optimization Bias on top and percentages below it adjacent to sentiment icons", () => {
      const panelTsx = fs.readFileSync(path.resolve("src/client/options/StrategyDiscoveryPanel.tsx"), "utf8");
      expect(panelTsx).toContain('className="strat-discovery-controls-row"');
      expect(panelTsx).toContain('className="strat-opt-deck-top"');
      expect(panelTsx).toContain('className="strat-opt-deck-bottom strat-opt-adjacent-factors"');
      expect(stratCss).toContain(".strat-opt-adjacent-deck");
      expect(stratCss).toContain("flex-direction: column");
      expect(stratCss).toContain(".strat-opt-deck-top");
      expect(stratCss).toContain(".strat-opt-deck-bottom");
      expect(tokensCss).toContain('[data-theme="light"] .strat-opt-adjacent-deck');
      expect(tokensCss).toContain('[data-theme="light"] .strat-opt-adjacent-factors .strat-factor-chip');
    });
  });
});
