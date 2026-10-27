import React from "react";
import { Button } from "../components/ui";

export interface LiveResultPreviewProps {
  liveResult: any;
  onPreviewTrade?: (candidate: any) => void;
}

export function LiveResultPreview({ liveResult, onPreviewTrade }: LiveResultPreviewProps) {
  if (!liveResult) return null;
  return (
        <div className="live-execution-preview">
          <div className="preview-top-bar">
            <h4>⚡ Live Screening Execution Completed</h4>
            <div className="dispatch-status-pills">
              <span className={`dispatch-pill ${liveResult.notifications?.slack ? "success" : liveResult.notifications?.slack === false ? "failed" : "skipped"}`}>
                Slack: {liveResult.notifications?.slack ? "✓ Sent" : liveResult.notifications?.slack === false ? "✕ Error" : "–"}
              </span>
              <span className={`dispatch-pill ${liveResult.notifications?.email ? "success" : liveResult.notifications?.email === false ? "failed" : "skipped"}`}>
                Email: {liveResult.notifications?.email ? "✓ Delivered" : liveResult.notifications?.email === false ? "✕ Error" : "–"}
              </span>
              <span className={`dispatch-pill ${liveResult.notifications?.webhook ? "success" : liveResult.notifications?.webhook === false ? "failed" : "skipped"}`}>
                Webhook: {liveResult.notifications?.webhook ? "✓ Dispatched" : liveResult.notifications?.webhook === false ? "✕ Error" : "–"}
              </span>
            </div>
          </div>

          <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.88rem" }}>
            {liveResult.summary}
          </p>

          {Array.isArray(liveResult.opportunities) && liveResult.opportunities.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--space-3)", marginTop: "0.5rem" }}>
              {liveResult.opportunities.map((opp: any) => {
                const cand = opp.pick?.best?.candidate;
                return (
                  <div key={opp.symbol} style={{ background: "var(--color-card)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                      <strong style={{ color: "var(--color-accent)", fontSize: "0.95rem" }}>{opp.symbol}</strong>
                      <span style={{ background: "var(--color-accent-subtle)", color: "var(--color-accent)", fontSize: "0.74rem", padding: "var(--space-0-5) var(--space-2)", borderRadius: "var(--radius-xs, 4px)", fontWeight: "bold" }}>
                        Score: {opp.score}/100
                      </span>
                    </div>
                    <p style={{ color: "var(--color-text-primary)", margin: "0 0 0.5rem", fontSize: "0.84rem", fontWeight: 600 }}>
                      {cand?.label || "Options Setup"}
                    </p>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.76rem", color: "var(--color-text-muted)" }}>
                      <span>Max Profit: <strong style={{ color: "var(--color-success)" }}>{cand?.maxProfitUnbounded ? "∞" : `$${cand?.maxProfit?.toFixed(2) || "0"}`}</strong></span>
                      <span>Max Loss: <strong style={{ color: "var(--color-danger)" }}>${cand?.maxLoss?.toFixed(2) || "0"}</strong></span>
                    </div>
                    {cand && onPreviewTrade && (
                      <Button
                        type="button"
                        style={{ marginTop: "0.6rem", width: "100%", padding: "var(--space-1-5)", fontSize: "0.74rem", background: "var(--color-accent-subtle)", border: "1px solid var(--color-border-focus)", color: "var(--color-accent)", borderRadius: "var(--radius-xs, 4px)", cursor: "pointer", fontWeight: 600 }}
                        onClick={() => onPreviewTrade(cand)}
                      >
                        ⚡ Preview in Order Ticket
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
  );
}
