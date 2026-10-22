/**
 * IAAA Admin panel (issue #945, IAAA-UI v1: READ-ONLY).
 *
 * Shows the platform admin's own memberships + role bindings, the
 * tenant's platform-genesis status, and recent tenant audit events
 * from GET /api/iaaa/overview. There is no mutation UI here: v1
 * cannot grant, revoke, or change anything — those are a later
 * slice. The server is the gate; on 403 this panel shows a plain
 * "not an admin" state and fetches nothing else.
 */

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Notice, Spinner } from "./components/ui";
import {
  fetchAdminOverview,
  formatEventTime,
  type AdminOverview,
} from "./iaaaAdminApi";
import "./iaaaAdminPanel.css";

export function IaaaAdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notAdmin, setNotAdmin] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setNotAdmin(false);
    try {
      setOverview(await fetchAdminOverview());
    } catch (err: any) {
      const message = err?.message || "Failed to load IAAA overview.";
      if (/403|Forbidden/.test(message)) {
        setNotAdmin(true);
      } else {
        setError(message);
      }
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (notAdmin) {
    return (
      <EmptyState
        title="Not an IAAA admin"
        description="This panel is only available to platform admins. If you should have access, sign in with an admin account."
      />
    );
  }
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!overview) return <EmptyState title="No IAAA data" description="The overview came back empty." />;

  const roles = overview.memberships.flatMap((m) =>
    m.roleBindings.map((b) => `${b.role} (${b.scope})`),
  );

  return (
    <div className="iaaa-admin-panel">
      <div className="iaaa-admin-summary">
        <div>
          <span className="iaaa-admin-label">Tenant</span>
          <strong>{overview.tenantId}</strong>
        </div>
        <div>
          <span className="iaaa-admin-label">Your roles</span>
          <strong>{roles.length > 0 ? roles.join(", ") : "None"}</strong>
        </div>
        <div>
          <span className="iaaa-admin-label">Platform genesis</span>
          <strong>
            {overview.genesis.platformGenesisOccurred ? "Completed" : "Not yet occurred"}
          </strong>
        </div>
      </div>

      <p className="iaaa-admin-note">
        Read-only view. Memberships, roles, and audit events cannot be changed from here.
      </p>

      <h4>Recent audit events</h4>
      {overview.recentAuditEvents.length === 0 ? (
        <EmptyState title="No audit events" description="No events recorded for this tenant yet." />
      ) : (
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Decision</th>
              <th>Outcome</th>
              <th>Correlation</th>
            </tr>
          </thead>
          <tbody>
            {overview.recentAuditEvents.map((event) => (
              <tr key={event.id}>
                <td>{formatEventTime(event.timestamp)}</td>
                <td>
                  <code>{event.action}</code>
                </td>
                <td>{event.decision}</td>
                <td>{event.outcome}</td>
                <td>
                  <code>{event.correlationId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
