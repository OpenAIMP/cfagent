/**
 * ReportAssetAgent (issue #680).
 *
 * Single owner for the Generate step of the generate/store/serve/deliver
 * model. All PDF asset generation flows through here — no caller generates
 * inline anymore.
 *
 * - Accepts a generation request (asset type + canonical data).
 * - Renders via the trading PDF renderers (one call site per type).
 * - Stores via reportBlobStore (R2 when bound, DO-storage otherwise).
 * - Returns the storage key + filename.
 *
 * Best-effort: generation failure returns null, never throws — the run
 * that requested the asset must not fail because rendering did.
 */

import { PortThink } from "../actors/thinkAdapter";
import type { Env } from "../types";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { putReportPdf } from "../services/reportBlobStore";

export type AssetType = "research" | "screener" | "options";

export interface AssetRequest {
  type: AssetType;
  /** Canonical data the renderer consumes (never a second copy). */
  data: unknown;
  /** Optional storage key; defaults to `report:pdf:<type>:<uuid>`. */
  key?: string;
  /** Optional filename override; defaults to the #297 convention. */
  fileName?: string;
  /** User scope for the storage namespace. */
  userLogin?: string;
}

export interface AssetResult {
  key: string;
  fileName: string;
}

/**
 * Issue #1958 (think-fleet, tracker #1951, shape (a)): this class
 * extends PortThink instead of Agent. It has no chat turn and no port
 * hooks of its own — nothing here drives a turn, so there is no hook
 * to preserve or translate; the PortThink protocol (one-shot
 * override, hook-order recording, synchronous onChatError text) is
 * inherited untouched, and any future turn would go through the
 * Think adapter, which owns the lifecycle boot (await
 * think.lifecycle.start() before any turn). The RPC surface below
 * (generateAsset/getAsset) is unchanged: Think extends Agent, so
 * this.ctx.storage and this.env behave exactly as before.
 */
export class ReportAssetAgent extends PortThink {
  /**
   * Generate + store one PDF asset. Returns null on any failure.
   *
   * Consolidation C4 (issue #1329, epic #1151): the agent no longer
   * calls the trading generators directly — it dispatches through the
   * pipeline's generateReportPdf/getReportFileName (the ONE generator
   * dispatch, src/services/unifiedReportPipeline.ts), completing the
   * epic's "report-asset-agent's direct PDF call moves behind
   * runReportPipeline" item. The agent remains the single owner of
   * the generate step; the pipeline owns the dispatch.
   */
  async generateAsset(request: AssetRequest): Promise<AssetResult | null> {
    try {
      const { type, data } = request;
      const { generateReportPdf, getReportFileName } = await import("../services/unifiedReportPipeline");
      const bytes = await generateReportPdf(type, data);
      const fileName = request.fileName ?? (await getReportFileName(type, data));

      const key =
        request.key ?? `report:pdf:${type}:${crypto.randomUUID().slice(0, 8)}`;
      const storage = {
        put: async (k: string, v: unknown) => {
          await (this.ctx.storage as any).put(k, v);
        },
        get: async (k: string) => (await (this.ctx.storage as any).get(k)) ?? null,
      };
      await putReportPdf(this.env, storage as any, key, fileName, bytes);
      return { key, fileName };
    } catch (err) {
      console.warn(`[ReportAssetAgent] generateAsset(${request.type}) failed:`, err);
      return null;
    }
  }

  /**
   * Fetch a stored asset by key.
   */
  async getAsset(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      const storage = {
        put: async (k: string, v: unknown) => {
          await (this.ctx.storage as any).put(k, v);
        },
        get: async (k: string) => (await (this.ctx.storage as any).get(k)) ?? null,
      };
      return await getReportPdf(this.env, storage as any, key);
    } catch (err) {
      console.warn(`[ReportAssetAgent] getAsset(${key}) failed:`, err);
      return null;
    }
  }
}

/**
 * Helper for callers: get the ReportAssetAgent for a user and generate.
 * The agent name is stable per user so assets are namespaced.
 */
export function reportAssetAgentName(userLogin: string, serviceUserLogin?: string | null): string {
  // Issue #1185: the bare "default" instance name belongs to the
  // configured service identity — the only login that maps to it.
  return serviceUserLogin && userLogin === serviceUserLogin
    ? "default"
    : `assets:${userLogin}`;
}

/**
 * Generate one PDF asset via the ReportAssetAgent DO.
 * Returns the storage key + filename, or null on any failure.
 * This is the single entry point all callers use (issue #680).
 */
export async function generatePdfAsset(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  type: AssetType,
  data: unknown
): Promise<AssetResult | null> {
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    if (!ns) {
      // Issue #912: was silent — log why PDF generation is skipped.
      console.error(`[ReportAssetAgent] generatePdfAsset(${type}) skipped: REPORT_ASSET_AGENT binding not configured in worker env. PDF will not be generated.`);
      return null;
    }
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    return await agent.generateAsset({ type, data, userLogin });
  } catch (err) {
    console.warn(`[ReportAssetAgent] generatePdfAsset(${type}) failed:`, err);
    return null;
  }
}

/**
 * Generate + fetch the bytes back (for callers that need the bytes inline,
 * e.g. Slack delivery). Returns null on any failure.
 */
export async function generatePdfAssetWithBytes(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  type: AssetType,
  data: unknown
): Promise<{ key: string; fileName: string; bytes: Uint8Array } | null> {
  const asset = await generatePdfAsset(env, userLogin, type, data);
  if (!asset) return null;
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    const stored = await agent.getAsset(asset.key);
    if (!stored) return null;
    return { key: asset.key, fileName: asset.fileName, bytes: stored.bytes };
  } catch {
    return null;
  }
}

/**
 * Fetch a stored asset by key via the ReportAssetAgent DO.
 */
export async function getPdfAsset(
  env: { REPORT_ASSET_AGENT?: any },
  userLogin: string,
  key: string
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  try {
    const ns = (env as any).REPORT_ASSET_AGENT;
    if (!ns) return null;
    const agent = ns.get(ns.idFromName(reportAssetAgentName(userLogin, getServiceUserLogin(env as Env)))) as unknown as ReportAssetAgent;
    return await agent.getAsset(key);
  } catch (err) {
    console.warn(`[ReportAssetAgent] getPdfAsset(${key}) failed:`, err);
    return null;
  }
}
