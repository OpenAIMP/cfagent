import React from "react";
import { LiveFlowItem } from "../../../trading/options/flows/types";

interface FlowTradeDetailModalProps {
  trade: LiveFlowItem;
  onClose: () => void;
  onOpenInBuilder: (trade: LiveFlowItem) => void;
  onUpgradeClick?: () => void;
}

export function FlowTradeDetailModal({
  trade,
  onClose,
  onOpenInBuilder,
  onUpgradeClick,
}: FlowTradeDetailModalProps) {
  // Title formatting
  const title = trade.strategyTitle || `${trade.symbol} ${trade.strategy}`;
  const company = trade.companyName || `${trade.symbol} Equity`;
  const timeFormatted = trade.timestamp
    ? new Date(trade.timestamp).toLocaleString("en-US", {
        month: "numeric",
        day: "numeric",
        year: "2-digit",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : trade.time.includes("/")
    ? (trade.time.includes("/26") ? trade.time : `${trade.time}/26`)
    : `${new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" })}, ${trade.time}`;

  // Default legs if not explicitly provided
  const legs = trade.legsDetails && trade.legsDetails.length > 0
    ? trade.legsDetails
    : [
        {
          action: trade.side === "BUY" ? "Buy" : "Sell",
          option: `${trade.strike}${trade.strategy.toLowerCase().includes("put") ? "P" : "C"} ${trade.expiration}`,
          quantity: trade.volume || 100,
          strike: typeof trade.strike === "number" ? trade.strike : undefined,
          optionType: (trade.strategy.toLowerCase().includes("put") ? "PUT" : "CALL") as "CALL" | "PUT",
        },
      ];

  const totalQuantity = trade.totalQuantity || legs.reduce((sum, l) => sum + (l.quantity || 0), 0);

  // Spot prices
  const spotFill = trade.spotAtFill ? `$${trade.spotAtFill.toFixed(2)}` : `$${trade.underlyingPrice.toFixed(2)}`;
  const spotCurrent = trade.currentSpot ? `$${trade.currentSpot.toFixed(2)}` : `$${trade.underlyingPrice.toFixed(2)}`;
  const isSpotUp = (trade.currentSpot || trade.underlyingPrice) >= (trade.spotAtFill || trade.underlyingPrice);

  // Option contract prices
  const fillPrice = trade.fillPrice ? `$${trade.fillPrice.toFixed(2)}` : `$1.57`;
  const currentContractPrice = trade.currentContractPrice ? `$${trade.currentContractPrice.toFixed(2)}` : `$1.63`;
  const isContractPriceUp = (trade.currentContractPrice || 1.63) >= (trade.fillPrice || 1.57);

  // Credit or debit
  const isCredit = trade.isCredit ?? (trade.side === "SELL" || trade.strategy.toLowerCase().includes("combo") || trade.strategy.toLowerCase().includes("credit"));
  const creditOrDebit = isCredit ? "CREDIT" : "DEBIT";

  // Calculations text
  const calcText = trade.calculationText ||
    `If making this trade now, you would receive a $162.50 credit. The maximum potential loss would be $9,587.50, and the maximum gain would be infinite. There is a --% 🔒 chance of profit, achieved when ${trade.symbol} is above $95.88 at expiry.`;

  return (
    <div className="flow-modal-overlay" onClick={onClose}>
      <div className="flow-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flow-modal-header">
          <div className="flow-modal-title-wrap">
            <h2 className="flow-modal-title">{title}</h2>
            <div className="flow-modal-subtitle">{company}</div>
          </div>
          <div className="flow-modal-header-right">
            <span className="flow-modal-time">{timeFormatted}</span>
            <button
              type="button"
              className="flow-modal-close-btn"
              onClick={onClose}
              aria-label="Close details"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Legs Table */}
        <div className="flow-modal-legs-section">
          <table className="flow-modal-legs-table">
            <thead>
              <tr>
                <th>ACTION</th>
                <th>OPTION</th>
                <th>QUANTITY</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, idx) => (
                <tr key={`${leg.action}_${leg.option}_${idx}`}>
                  <td className="flow-leg-action">{leg.action}</td>
                  <td className="flow-leg-option">{leg.option}</td>
                  <td className="flow-leg-qty">{leg.quantity.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flow-modal-legs-total">
            {totalQuantity.toLocaleString()} TOTAL
          </div>
        </div>

        {/* 6 Key Metrics Grid */}
        <div className="flow-modal-metrics-grid">
          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">PREMIUM</div>
            <div className="flow-metric-value">{trade.premiumFormatted}</div>
            <div className="flow-metric-sub">{creditOrDebit}</div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">PRICE</div>
            <div className="flow-metric-value">
              {fillPrice}
              <sup style={{ fontSize: "0.65em", marginLeft: "2px" }}>B</sup>
            </div>
            <div className={`flow-metric-sub ${isContractPriceUp ? "up" : "down"}`}>
              {isContractPriceUp ? "▲" : "▼"} {currentContractPrice} NOW*
            </div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">SPOT</div>
            <div className="flow-metric-value">{spotFill}</div>
            <div className={`flow-metric-sub ${isSpotUp ? "up" : "down"}`}>
              {isSpotUp ? "▲" : "▼"} {spotCurrent} NOW*
            </div>
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">VOLUME / OI</div>
            <div className="flow-metric-value">
              {trade.volume.toLocaleString()} / {trade.openInterest.toLocaleString()}
            </div>
          </div>

          <div className="flow-modal-metric-card" title={trade.sentimentReasoning || ""}>
            <div className="flow-metric-label">SENTIMENT</div>
            <div className={`flow-metric-value sentiment-${trade.sentiment}`}>
              {trade.sentiment.charAt(0).toUpperCase() + trade.sentiment.slice(1)}
            </div>
            {trade.sentimentReasoning && (
              <div className="flow-metric-sub" style={{ fontSize: "0.68rem", opacity: 0.85 }}>
                {trade.confidenceScore ? `${trade.confidenceScore}% conv.` : "Rule Evaluated"}
              </div>
            )}
          </div>

          <div className="flow-modal-metric-card">
            <div className="flow-metric-label">FLOW TYPE</div>
            <div className="flow-metric-value">
              {trade.flowTypeCategory || (trade.type === "SINGLE" ? "Single" : trade.type)}
            </div>
          </div>
        </div>

        <div className="flow-modal-delayed-note">
          *Prices delayed 15 minutes (upgrade for live data)
        </div>

        {/* Performance Box */}
        <div className="flow-modal-section-card">
          <h4 className="flow-modal-section-title">Performance</h4>
          <div className="flow-performance-metrics-row">
            <div className="flow-perf-item">
              <span className="flow-perf-label">NOW</span>
              <span className="flow-perf-val">--% 🔒</span>
            </div>
            <div className="flow-perf-item">
              <span className="flow-perf-label">HIGH</span>
              <span className="flow-perf-val">--% 🔒</span>
            </div>
            <div className="flow-perf-item">
              <span className="flow-perf-label">LOW</span>
              <span className="flow-perf-val">--% 🔒</span>
            </div>
          </div>
          <div
            className="flow-modal-upgrade-hint"
            onClick={onUpgradeClick}
            style={{ cursor: "pointer" }}
          >
            Upgrade to view performance information
          </div>
        </div>

        {/* Calculations Box */}
        <div className="flow-modal-section-card">
          <h4 className="flow-modal-section-title">Calculations</h4>
          <p className="flow-modal-calc-text">{calcText}</p>
        </div>

        {/* Open in Builder Button */}
        <div className="flow-modal-action-row">
          <button
            type="button"
            className="flow-btn-open-builder"
            onClick={() => onOpenInBuilder(trade)}
          >
            Open in Builder
          </button>
        </div>
      </div>
    </div>
  );
}
