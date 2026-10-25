import React from "react";

export interface AuditTrailSectionProps {
  auditLogs: any[];
  loadingAudit: boolean;
  fetchAudit: () => Promise<void>;
}

export function AuditTrailSection({ auditLogs, loadingAudit, fetchAudit }: AuditTrailSectionProps) {
  return (
      <section className="sched-section-card">
        <header className="sched-section-header">
          <h4>
            <span>📜</span> Execution History &amp; Audit Trail
            <span className="sched-count-pill">{auditLogs.length} Events</span>
          </h4>
          <button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchAudit}
            disabled={loadingAudit}
          >
            {loadingAudit ? "Loading…" : "↻ Refresh"}
          </button>
        </header>

        {auditLogs.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)", fontSize: "0.85rem", margin: "0.5rem 0" }}>
            No recent options scheduling audit logs found. Run a screen or wait for the next scheduled interval to populate this ledger.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="sched-audit-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Event Type</th>
                  <th>Run ID</th>
                  <th>Screen Type</th>
                  <th>Run Type</th>
                  <th>Symbols</th>
                  <th>Actionable Setups</th>
                  <th>Dispatched Channels</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log: any) => {
                  const payload = log.payload || {};
                  const isSuccess = !log.type.includes("failed");
                  const notifs = payload.notifications || {};
                  const callback = String(payload.callback || "");
                  const screenType = payload.screenType ||
                    (log.type.startsWith("screener.") || callback.includes("MarketScreen") ? "stock" :
                      log.type.startsWith("options.") || callback.includes("OptionsAnalysis") ? "options" : null);
                  const runType = payload.runType || payload.trigger ||
                    (log.type.startsWith("schedule.") ? "scheduled" : null);
                  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
                  const actionableSetups = payload.opportunityCount ?? payload.matchedCount ?? payload.withTrades;
                  const dispatchedChannels = ["slack", "email", "webhook"]
                    .filter((channel) => Object.prototype.hasOwnProperty.call(notifs, channel))
                    .map((channel) => `${channel[0].toUpperCase()}${channel.slice(1)}: ${notifs[channel] ? "sent" : "not sent"}`);

                  return (
                    <tr key={log.id}>
                      <td>{new Date(log.created_at || log.createdAt).toLocaleTimeString()}</td>
                      <td>
                        <span className={`status-indicator-dot ${isSuccess ? "green" : "red"}`} />
                        <code>{log.type}</code>
                      </td>
                      <td><code>{payload.runId || "–"}</code></td>
                      <td>{screenType ? screenType[0].toUpperCase() + screenType.slice(1) : "–"}</td>
                      <td>{runType ? String(runType).replace(/[-_]/g, " ").replace(/^./, (value: string) => value.toUpperCase()) : "–"}</td>
                      <td>{symbols.length > 0 ? symbols.join(", ") : "–"}</td>
                      <td>
                        <strong style={{ color: Number(actionableSetups) > 0 ? "var(--color-success)" : "var(--color-text-muted)" }}>
                          {actionableSetups ?? "–"}
                        </strong>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.3rem" }}>
                          {dispatchedChannels.length > 0 ? dispatchedChannels.join(", ") : "–"}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
  );
}
