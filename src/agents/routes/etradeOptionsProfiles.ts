/**
 * Issue #995: E*TRADE options route sub-domain module, split out of
 * src/agents/routes/etradeOptions.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeOptions.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the strategy profiles and strategy candidate reviews
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import {
  validateStrategyProfile,
  type StrategyProfileSpec,
} from "../../trading";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import type { SqlStorage } from "../../orm";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

export async function handleOptionsProfilesList(request: Request, sessionId: string, sql: SqlStorage): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).strategyProfiles;
    const profiles = await store.list(userLogin);
    return Response.json({ count: profiles.length, profiles });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list strategy profiles" }, { status: 500 });
  }
}

export async function handleOptionsProfilesCreate(request: Request, sessionId: string, sql: SqlStorage): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { name, ...spec } = body;
    const profileName = typeof name === "string" ? name : "";
    const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }
    const store = createOptionsDiscoveryPorts({ sql }).strategyProfiles;
    try {
      const profile = await store.create(userLogin, profileName, spec as StrategyProfileSpec);
      return Response.json(profile, { status: 201 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 500 });
  }
}

export async function handleOptionsProfileGet(request: Request, sessionId: string, sql: SqlStorage, profileIdMatch: RegExpMatchArray): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).strategyProfiles;
    const profile = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
    if (!profile) {
      return Response.json({ error: "profile not found" }, { status: 404 });
    }
    return Response.json(profile);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch strategy profile" }, { status: 500 });
  }
}

export async function handleOptionsProfileUpdate(request: Request, sessionId: string, sql: SqlStorage, profileIdMatch: RegExpMatchArray): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).strategyProfiles;
    const existing = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
    if (!existing) {
      return Response.json({ error: "profile not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { name, ...spec } = body;
    // The body name wins when present; otherwise the profile keeps
    // its current name (validation runs against the effective one).
    const profileName = typeof name === "string" ? name : existing.name;
    const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }
    try {
      const updated = await store.update(userLogin, existing.id, spec as StrategyProfileSpec, typeof name === "string" ? name : undefined);
      return Response.json(updated);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 500 });
  }
}

export async function handleOptionsProfileDelete(request: Request, sessionId: string, sql: SqlStorage, profileIdMatch: RegExpMatchArray): Promise<Response> {
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).strategyProfiles;
    const deleted = await store.delete(userLogin, decodeURIComponent(profileIdMatch[1]));
    if (!deleted) {
      return Response.json({ error: "profile not found" }, { status: 404 });
    }
    return Response.json({ deleted: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete strategy profile" }, { status: 500 });
  }
}

export async function handleOptionsStrategyReviewsList(url: URL, ctx: EtradeOptionsRouteContext): Promise<Response> {
  try {
    const { listStrategyReviews } = await import("../../services/strategyReviews");
    const decision = url.searchParams.get("decision") || undefined;
    return Response.json({ reviews: listStrategyReviews(ctx.getOrm(), decision) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list reviews" }, { status: 500 });
  }
}

export async function handleOptionsStrategyReviewsDecide(request: Request, ctx: EtradeOptionsRouteContext): Promise<Response> {
  try {
    const { decideStrategyReview } = await import("../../services/strategyReviews");
    const body = (await request.json().catch(() => ({}))) as any;
    const { id, decision } = body;
    if (!id || (decision !== "approved" && decision !== "rejected")) {
      return Response.json({ error: "id and decision (approved|rejected) required" }, { status: 400 });
    }
    const ok = decideStrategyReview(ctx.getOrm(), id, decision);
    return Response.json({ success: ok });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to record decision" }, { status: 500 });
  }
}
