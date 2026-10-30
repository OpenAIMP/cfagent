/**
 * Issue #1651 ([AGENTIC] Slice 1) — pure, testable handlers for
 * the chain-status read route and the reconciliation operator
 * route. The Worker route in src/server.ts only wires real
 * dependencies into these functions; every decision below is
 * covered by tests/data_foundation_slice1.test.ts.
 *
 * The status route reads the PROJECTION ONLY, never the durable
 * object, and returns only projection fields (id, status,
 * version, kind, cron, timestamps). It says nothing about auth
 * material. Decision order (same shape as the slice-0 seed
 * route): unauthenticated → 401; wrong method → 405; missing
 * chain id → 400; otherwise the tenant-scoped read.
 *
 * The reconcile route is the operator invocation point for
 * `reconcileChainSchedules`: platform-admin only, POST only,
 * never auto-run. It returns the reconciliation report so the
 * operator sees exactly what changed.
 */
import type {
  ChainRow,
  ScheduleRow,
} from "./chainSchedulePorts";
import type { ReconcileReport } from "./chainScheduleProjection";
import { isChainOperationAllowed } from "./chainAuthority";

export interface ChainStatusRouteSession {
  githubLogin?: string;
  internalUserId?: string;
}

export interface ChainStatus {
  chain: ChainRow | null;
  schedule: ScheduleRow | null;
}

export interface ChainStatusRouteDeps {
  session: ChainStatusRouteSession | null;
  method: string;
  tenantId: string;
  chainId: string;
  readStatus: (input: {
    tenantId: string;
    chainId: string;
  }) => Promise<ChainStatus>;
}

export interface ChainStatusResponseBody {
  projected: boolean;
  chain: {
    chainId: string;
    status: string;
    version: number;
    goal: string;
    updatedAtMs: number;
  } | null;
  schedule: {
    scheduleId: string;
    status: string;
    version: number;
    kind: string;
    cron: string | null;
    updatedAtMs: number;
  } | null;
}

export async function handleChainStatusRoute(
  deps: ChainStatusRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.chainId) {
    return Response.json({ error: "chainId is required." }, { status: 400 });
  }
  try {
    const status = await deps.readStatus({
      tenantId: deps.tenantId,
      chainId: deps.chainId,
    });
    const body: ChainStatusResponseBody = {
      projected: status.chain !== null || status.schedule !== null,
      chain: status.chain
        ? {
            chainId: status.chain.chainId,
            status: status.chain.status,
            version: status.chain.version,
            goal: status.chain.goal,
            updatedAtMs: status.chain.updatedAtMs,
          }
        : null,
      schedule: status.schedule
        ? {
            scheduleId: status.schedule.scheduleId,
            status: status.schedule.status,
            version: status.schedule.version,
            kind: status.schedule.kind,
            cron: status.schedule.cron,
            updatedAtMs: status.schedule.updatedAtMs,
          }
        : null,
    };
    return Response.json(body);
  } catch {
    return Response.json(
      { error: "Chain status unavailable." },
      { status: 500 },
    );
  }
}

export interface ReconcileChainsRouteDeps {
  session: ChainStatusRouteSession | null;
  method: string;
  isPlatformAdmin: boolean;
  tenantId: string;
  runReconcile: (input: {
    tenantId: string;
    /**
     * Issue #2426: the operator's login from the session, threaded
     * to the agent so the reconciliation's audit row names its real
     * actor. Absent when the session carries no login — the agent
     * then records its own named identity.
     */
    actor?: string;
  }) => Promise<ReconcileReport>;
}

export async function handleReconcileChainsRoute(
  deps: ReconcileChainsRouteDeps,
): Promise<Response> {
  if (!deps.session) {
    return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
  }
  if (deps.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!deps.session.internalUserId) {
    return Response.json(
      { error: "Forbidden: chain reconciliation requires a wired session." },
      { status: 403 },
    );
  }
  // Issue #1688 (slice 3): reconcile is gated by the chain
  // authority matrix, not an ad-hoc flag — only the
  // platform-admin role may reconcile. Behavior is
  // unchanged (non-admin → 403); the matrix is now the
  // single statement of that rule.
  const role = deps.isPlatformAdmin ? "platform-admin" : "signed-in";
  if (!isChainOperationAllowed(role, "reconcile")) {
    return Response.json(
      { error: "Forbidden: chain reconciliation requires platform-admin membership." },
      { status: 403 },
    );
  }
  try {
    const actor = deps.session.githubLogin?.trim();
    const report = await deps.runReconcile({
      tenantId: deps.tenantId,
      ...(actor ? { actor } : {}),
    });
    return Response.json(report);
  } catch {
    return Response.json(
      { error: "Chain reconciliation unavailable." },
      { status: 500 },
    );
  }
}
