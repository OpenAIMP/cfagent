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

                  return (
                    <tr key={log.id}>
                      <td>{new Date(log.created_at || log.createdAt).toLocaleTimeString()}</td>
                      <td>
                        <span className={`status-indicator-dot ${isSuccess ? "green" : "red"}`} />
                        <code>{log.type}</code>
                      </td>
                      <td>
                        {Array.isArray(payload.symbols) ? payload.symbols.join(", ") : "–"}
                      </td>
                      <td>
                        <strong style={{ color: payload.withTrades > 0 ? "var(--color-success)" : "var(--color-text-muted)" }}>
                          {payload.withTrades ?? "–"}
                        </strong>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.3rem" }}>
                          {notifs.slack && <span className="chan-badge slack">Slack</span>}
                          {notifs.email && <span className="chan-badge email">Email</span>}
                          {notifs.webhook && <span className="chan-badge webhook">Webhook</span>}
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
