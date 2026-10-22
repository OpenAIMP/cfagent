/**
 * IAAA Admin panel (issue 945, IAAA-UI v1 + v2: READ-ONLY).
 *
 * v1: the platform admin's own memberships + role bindings, the
 * tenant's platform-genesis status, and recent tenant audit events
 * from GET /api/iaaa/overview. v2 adds a tabbed endpoint/event
 * explorer on top of the same gate: the API route table from
 * server.ts, the MCP catalogs, the IAAA audit-event taxonomy, and
 * the mapping tables between them. The explorer tabs are static
 * code knowledge (no user data) and render only after the overview
 * fetch succeeds — the panel stays gated behind the overview route
 * as a whole. There is no mutation UI here: nothing here can grant,
 * revoke, or change anything — those are a later slice. The server
 * is the gate; on 403 this panel shows a plain "not an admin" state
 * and fetches nothing else.
 */

import { useCallback, useEffect, useState } from "react";
import { EmptyState, Notice, Spinner, Tabs, TabPanel } from "./components/ui";
import {
  fetchAdminOverview,
  formatEventTime,
  type AdminOverview,
} from "./iaaaAdminApi";
import {
  API_ENDPOINT_CATALOG,
  IAAA_AUDIT_EVENT_CATALOG,
  IAAA_CATALOG_GAPS,
  IAAA_CORRELATION_ROWS,
} from "./iaaaEndpointCatalog";
import {
  MCP_PROMPTS_CATALOG,
  MCP_RESOURCES_CATALOG,
  MCP_TOOLS_CATALOG,
} from "./mcpEndpointsData";
import "./iaaaAdminPanel.css";

type IaaaAdminTab = "overview" | "api" | "mcp" | "iaaa" | "correlations";

const IAAA_ADMIN_TABS = [
  { id: "overview", label: "Overview" },
  { id: "api", label: "API" },
  { id: "mcp", label: "MCP" },
  { id: "iaaa", label: "IAAA" },
  { id: "correlations", label: "Correlations" },
] as const;

export function IaaaAdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notAdmin, setNotAdmin] = useState(false);
  const [tab, setTab] = useState<IaaaAdminTab>("overview");

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
      <Tabs
        tabs={[...IAAA_ADMIN_TABS]}
        value={tab}
        onChange={setTab}
        ariaLabel="IAAA admin sections"
        idBase="iaaa-admin"
      />

      <TabPanel idBase="iaaa-admin" tabId="overview" active={tab === "overview"}>
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
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="api" active={tab === "api"}>
        <p className="iaaa-admin-note">
          Every HTTP endpoint in the worker route table, derived from the server route
          branches. Aliases are one endpoint, not several. The catch-all forwarder is
          marked as such — it is not an endpoint.
        </p>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Path</th>
              <th>Gating</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {API_ENDPOINT_CATALOG.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td>
                  <code>{endpoint.method}</code>
                </td>
                <td>
                  <code>{endpoint.path}</code>
                  {endpoint.aliases.length > 0 && (
                    <div className="iaaa-admin-aliases">
                      aliases: {endpoint.aliases.join(", ")}
                    </div>
                  )}
                </td>
                <td>
                  <span className="iaaa-admin-badge">{endpoint.auth}</span>
                  {endpoint.kind !== "http" && (
                    <span className="iaaa-admin-badge iaaa-admin-badge-kind">{endpoint.kind}</span>
                  )}
                </td>
                <td>{endpoint.authNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="mcp" active={tab === "mcp"}>
        <p className="iaaa-admin-note">
          The MCP tools, resources, and prompts from the existing client catalog — reused,
          not duplicated. Server capabilities the catalog lacks are listed below as gaps.
        </p>
        <h4>Tools ({MCP_TOOLS_CATALOG.length})</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOLS_CATALOG.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                </td>
                <td>{tool.category}</td>
                <td>{tool.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Resources ({MCP_RESOURCES_CATALOG.length})</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>URI</th>
              <th>Name</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {MCP_RESOURCES_CATALOG.map((resource) => (
              <tr key={resource.uri}>
                <td>
                  <code>{resource.uri}</code>
                </td>
                <td>{resource.name}</td>
                <td>{resource.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Prompts ({MCP_PROMPTS_CATALOG.length})</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {MCP_PROMPTS_CATALOG.map((prompt) => (
              <tr key={prompt.name}>
                <td>
                  <code>{prompt.name}</code>
                </td>
                <td>{prompt.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Not in this catalog (server capabilities reported as gaps)</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {IAAA_CATALOG_GAPS.filter((gap) => gap.area === "mcp").map((gap) => (
              <tr key={gap.item}>
                <td>
                  <code>{gap.item}</code>
                </td>
                <td>{gap.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="iaaa" active={tab === "iaaa"}>
        <p className="iaaa-admin-note">
          The full IAAA audit-event taxonomy the code can emit, with the builder and the
          live emitting site for each event. Occurrences that emit no audit event are
          listed below as gaps — never fabricated into events.
        </p>
        <h4>Audit events</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Decision</th>
              <th>Outcome</th>
              <th>Emitted</th>
              <th>Builder / emitter</th>
              <th>Fields</th>
            </tr>
          </thead>
          <tbody>
            {IAAA_AUDIT_EVENT_CATALOG.map((event) => (
              <tr key={`${event.action} ${event.decision} ${event.outcome}`}>
                <td>
                  <code>{event.action}</code>
                </td>
                <td>{event.decision}</td>
                <td>{event.outcome}</td>
                <td>{event.emitted ? "Yes" : "No — builder only"}</td>
                <td>
                  <div>{event.builder}</div>
                  {event.emitter && <div className="iaaa-admin-aliases">{event.emitter}</div>}
                </td>
                <td>{event.fields.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Gaps — IAAA occurrences with no audit event</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Occurrence</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {IAAA_CATALOG_GAPS.filter((gap) => gap.area === "iaaa").map((gap) => (
              <tr key={gap.item}>
                <td>
                  <code>{gap.item}</code>
                </td>
                <td>{gap.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabPanel>

      <TabPanel idBase="iaaa-admin" tabId="correlations" active={tab === "correlations"}>
        <p className="iaaa-admin-note">
          Mapping tables. Rows with no counterpart are shown as UNMAPPED, not forced into
          a match. Every row cites its source in the catalog module.
        </p>
        <h4>API endpoint ↔ MCP tool</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>MCP entry</th>
              <th>Relation</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {IAAA_CORRELATION_ROWS.filter((row) => row.kind === "endpoint-mcp").map(
              (row, index) => (
                <tr key={`endpoint-mcp-${index}`}>
                  <td>
                    <code>{row.left}</code>
                  </td>
                  <td>{row.right === null ? "UNMAPPED" : <code>{row.right}</code>}</td>
                  <td>
                    <span className="iaaa-admin-badge">{row.relation}</span>
                  </td>
                  <td>{row.note}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        <h4>IAAA event ↔ endpoint</h4>
        <table className="iaaa-admin-table">
          <thead>
            <tr>
              <th>Event / occurrence</th>
              <th>Endpoint</th>
              <th>Relation</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {IAAA_CORRELATION_ROWS.filter((row) => row.kind === "event-endpoint").map(
              (row, index) => (
                <tr key={`event-endpoint-${index}`}>
                  <td>
                    <code>{row.left}</code>
                  </td>
                  <td>{row.right === null ? "UNMAPPED" : <code>{row.right}</code>}</td>
                  <td>
                    <span className="iaaa-admin-badge">{row.relation}</span>
                  </td>
                  <td>{row.note}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </TabPanel>
    </div>
  );
}
