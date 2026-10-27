import React from "react";
import { Button, Table } from "../components/ui";

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
          <Button
            type="button"
            className="btn-sched-action-sm"
            onClick={fetchAudit}
            disabled={loadingAudit}
          >
            {loadingAudit ? "Loading…" : "↻ Refresh"}
          </Button>
        </header>

        {auditLogs.length === 0 ? (
          <p style={{ color: "var(--color-text-dim)", fontSize: "0.85rem", margin: "0.5rem 0" }}>
            No recent options scheduling audit logs found. Run a screen or wait for the next scheduled interval to populate this ledger.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <Table
              columns={[
                { key: "timestamp", header: "Timestamp", render: (log: any) => new Date(log.created_at || log.createdAt).toLocaleTimeString() },
                {
                  key: "eventType",
                  header: "Event Type",
                  render: (log: any) => (
                    <>
                      <span className={`status-indicator-dot ${!log.type.includes("failed") ? "green" : "red"}`} />
                      <code>{log.type}</code>
                    </>
                  ),
                },
                { key: "runId", header: "Run ID", render: (log: any) => <code>{(log.payload || {}).runId || "–"}</code> },
                {
                  key: "screenType",
                  header: "Screen Type",
                  render: (log: any) => {
                    const payload = log.payload || {};
                    const callback = String(payload.callback || "");
                    const screenType = payload.screenType ||
                      (log.type.startsWith("screener.") || callback.includes("MarketScreen") ? "stock" :
                        log.type.startsWith("options.") || callback.includes("OptionsAnalysis") ? "options" : null);
                    return screenType ? screenType[0].toUpperCase() + screenType.slice(1) : "–";
                  },
                },
                {
                  key: "runType",
                  header: "Run Type",
                  render: (log: any) => {
                    const payload = log.payload || {};
                    const runType = payload.runType || payload.trigger ||
                      (log.type.startsWith("schedule.") ? "scheduled" : null);
                    return runType ? String(runType).replace(/[-_]/g, " ").replace(/^./, (value: string) => value.toUpperCase()) : "–";
                  },
                },
                {
                  key: "symbols",
                  header: "Symbols",
                  render: (log: any) => {
                    const symbols = Array.isArray((log.payload || {}).symbols) ? (log.payload || {}).symbols : [];
                    return symbols.length > 0 ? symbols.join(", ") : "–";
                  },
                },
                {
                  key: "setups",
                  header: "Actionable Setups",
                  render: (log: any) => {
                    const payload = log.payload || {};
                    const actionableSetups = payload.opportunityCount ?? payload.matchedCount ?? payload.withTrades;
                    return (
                      <strong style={{ color: Number(actionableSetups) > 0 ? "var(--color-success)" : "var(--color-text-muted)" }}>
                        {actionableSetups ?? "–"}
                      </strong>
                    );
                  },
                },
                {
                  key: "channels",
                  header: "Dispatched Channels",
                  render: (log: any) => {
                    const payload = log.payload || {};
                    const notifs = payload.notifications || {};
                    const dispatchedChannels = ["slack", "email", "webhook"]
                      .filter((channel) => Object.prototype.hasOwnProperty.call(notifs, channel))
                      .map((channel) => `${channel[0].toUpperCase()}${channel.slice(1)}: ${notifs[channel] ? "sent" : "not sent"}`);
                    return (
                      <div style={{ display: "flex", gap: "var(--space-1)" }}>
                        {dispatchedChannels.length > 0 ? dispatchedChannels.join(", ") : "–"}
                      </div>
                    );
                  },
                },
              ]}
              rows={auditLogs}
              rowKey={(log: any) => log.id}
            />
          </div>
        )}
      </section>
  );
}
