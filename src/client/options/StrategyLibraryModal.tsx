/**
 * Reusable Strategy Library Modal — single source of truth for strategy selection.
 * 
 * Used by:
 * - StrategyDiscoveryPanel (single-select, "Select Strategy →")
 * - ScannerPanel (multi-select, "Apply" with selected IDs)
 * 
 * Data: Scanner catalog (id, label, description, theses[], category) — preserves thesis tags.
 * UI: Discovery modal cards (search, category tabs, payoff diagrams, risk badges).
 * 
 * Issue #450: Unify strategy catalog.
 */

import { useMemo, useState } from "react";

export interface StrategyInfo {
  id: string;
  label: string;
  category: string;
  description: string;
  theses: string[];
  aliases: string[];
}

interface StrategyLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  strategies: StrategyInfo[];
  // Single-select mode (Discovery)
  onSelect?: (strategyId: string) => void;
  // Multi-select mode (Scanner)
  multiSelect?: boolean;
  selectedIds?: string[];
  onApply?: (selectedIds: string[]) => void;
}

const CATEGORIES = ["All", "Bullish", "Bearish", "Neutral", "Volatility", "Synthetics & Spreads"] as const;

export function StrategyLibraryModal({
  isOpen,
  onClose,
  strategies,
  onSelect,
  multiSelect = false,
  selectedIds = [],
  onApply,
}: StrategyLibraryModalProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [localSelected, setLocalSelected] = useState<string[]>(selectedIds);

  const normalize = (t: string) => t.toLowerCase().replace(/_/g, " ");

  const filtered = useMemo(() => {
    return strategies.filter((s) => {
      const matchCat =
        categoryFilter === "All" ||
        s.theses.some((t) => normalize(t) === normalize(categoryFilter)) ||
        normalize(s.category) === normalize(categoryFilter);
      const q = searchQuery.trim().toLowerCase();
      const matchSearch =
        q === "" ||
        s.label.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q);
      return matchCat && matchSearch;
    });
  }, [strategies, categoryFilter, searchQuery]);

  if (!isOpen) return null;

  const toggleSelect = (id: string) => {
    if (multiSelect) {
      setLocalSelected((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      );
    } else {
      onSelect?.(id);
    }
  };

  return (
    <div className="strat-modal-backdrop" onClick={onClose}>
      <div className="strat-strategy-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="strat-modal-header">
          <div className="strat-modal-header-titles">
            <h3>Options Strategy Library ({strategies.length} Strategies)</h3>
            <span>
              {multiSelect
                ? `Select strategies for the scan (${localSelected.length} selected)`
                : "Choose a pre-made strategy to evaluate profit/loss characteristics"}
            </span>
          </div>
          <button type="button" className="strat-modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="strat-library-toolbar">
          <div className="strat-library-search">
            <input
              type="text"
              placeholder="Search by strategy name or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
          </div>
          <div className="strat-library-categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`strat-cat-btn ${categoryFilter === cat ? "active" : ""}`}
                onClick={() => setCategoryFilter(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="strat-library-grid">
          {filtered.map((s) => {
            const isSelected = multiSelect && localSelected.includes(s.id);
            return (
              <div
                key={s.id}
                className={`strat-card ${isSelected ? "selected" : ""}`}
                onClick={() => toggleSelect(s.id)}
              >
                <div className="strat-card-header">
                  <h4>{s.label}</h4>
                  {multiSelect && (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(s.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </div>
                <div className="strat-card-theses">
                  {s.theses.map((t) => (
                    <span key={t} className="strat-thesis-tag">
                      {t}
                    </span>
                  ))}
                </div>
                <p className="strat-card-desc">{s.description}</p>
                {!multiSelect && (
                  <button type="button" className="strat-lib-select-btn">
                    Select Strategy →
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {multiSelect && (
          <div className="strat-modal-footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onApply?.(localSelected);
                onClose();
              }}
            >
              Apply ({localSelected.length} selected)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
