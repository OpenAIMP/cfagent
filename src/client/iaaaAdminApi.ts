/**
 * Client for the read-only IAAA admin overview (issue #945, IAAA-UI v1):
 * GET /api/iaaa/overview. Read-only by construction — there is no
 * mutation endpoint to call, and this module exposes no write call.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 * The panel renders only payloads that pass isAdminOverview; a 403
 * body ("not an admin") or garbage must never reach the table.
 */

import { apiFetch } from "./apiFetch";

export interface AdminRoleBindingView {
  role: string;
  scope: string;
  grantedBy: string;
  expiresAtMs?: number;
}

export interface AdminMembershipView {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  roleBindings: AdminRoleBindingView[];
  createdBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

export interface AdminAuditEventView {
  id: string;
  timestamp: number;
  type: string;
  actorPrincipalId: string;
  initiatingPrincipalId: string;
  action: string;
  decision: string;
  outcome: string;
  correlationId: string;
  resourceId?: string;
  errorCode?: string;
}

export interface AdminOverview {
  tenantId: string;
  callerInternalUserId: string;
  memberships: AdminMembershipView[];
  genesis: { platformGenesisOccurred: boolean };
  recentAuditEvents: AdminAuditEventView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMembership(value: unknown): value is AdminMembershipView {
  if (!isRecord(value)) return false;
  return (
    typeof value.membershipId === "string" &&
    typeof value.internalUserId === "string" &&
    typeof value.tenantId === "string" &&
    Array.isArray(value.roleBindings) &&
    typeof value.createdBy === "string" &&
    typeof value.createdAtMs === "number"
  );
}

function isAuditEvent(value: unknown): value is AdminAuditEventView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.action === "string" &&
    typeof value.decision === "string" &&
    typeof value.outcome === "string" &&
    typeof value.correlationId === "string"
  );
}

/** Shape guard: true only for a well-formed overview payload. */
export function isAdminOverview(value: unknown): value is AdminOverview {
  if (!isRecord(value)) return false;
  if (typeof value.tenantId !== "string") return false;
  if (typeof value.callerInternalUserId !== "string") return false;
  if (!Array.isArray(value.memberships) || !value.memberships.every(isMembership)) return false;
  if (!isRecord(value.genesis) || typeof value.genesis.platformGenesisOccurred !== "boolean") {
    return false;
  }
  if (!Array.isArray(value.recentAuditEvents) || !value.recentAuditEvents.every(isAuditEvent)) {
    return false;
  }
  return true;
}

async function send<T>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

/** Fetch the overview; throws on 401/403/500 with the server message. */
export async function fetchAdminOverview(): Promise<AdminOverview> {
  const data = await send<unknown>("/api/iaaa/overview");
  if (!isAdminOverview(data)) throw new Error("Unexpected IAAA overview response.");
  return data;
}

/**
 * Issue #1274 — access requests (list + decide). The list/decide
 * routes are tenant-admin gated server-side; a 403 here means the
 * caller cannot grant, never a client bug. Payloads that fail the
 * shape guard throw instead of rendering.
 */
export interface AccessRequestView {
  requestId: string;
  requesterInternalUserId: string;
  requestedRole: string;
  scope: string;
  tenantId: string;
  status: "pending" | "approved" | "denied";
  createdAtMs: number;
  decidedAtMs?: number;
  decidedBy?: string;
}

function isAccessRequestView(value: unknown): value is AccessRequestView {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === "string" &&
    typeof value.requesterInternalUserId === "string" &&
    typeof value.requestedRole === "string" &&
    typeof value.status === "string" &&
    (value.status === "pending" || value.status === "approved" || value.status === "denied") &&
    typeof value.createdAtMs === "number"
  );
}

export async function fetchAccessRequests(): Promise<AccessRequestView[]> {
  const data = await send<{ requests?: unknown }>("/api/iaaa/access-requests");
  if (!Array.isArray(data.requests) || !data.requests.every(isAccessRequestView)) {
    throw new Error("Unexpected access-request list response.");
  }
  return data.requests;
}

export async function decideAccessRequest(
  requestId: string,
  decision: "approve" | "deny",
): Promise<AccessRequestView> {
  const resp = await apiFetch("/api/iaaa/access-request/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, decision }),
  });
  const data = (await resp.json().catch(() => ({}))) as { request?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  if (!isAccessRequestView(data.request)) throw new Error("Unexpected access-request decision response.");
  return data.request;
}

/** "2026-10-22 · 14:32" style timestamp; "—" for invalid input. */
export function formatEventTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
