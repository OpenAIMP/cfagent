import { describe, it, expect, vi } from "vitest";
import { isStaticAssetRequest, serveStaticAsset } from "../src/security/staticAssets";
import type { Env } from "../src/types";

/**
 * Issue #329: `run_worker_first` sends static asset requests through the
 * Worker, where `requireAuth` used to spend a SESSIONS KV `get()` before
 * ASSETS answered. These tests pin both halves of the contract: asset requests
 * are answered by the binding without KV, and they are still *served* — not
 * answered with the placeholder 404/204 an earlier revision returned, which
 * would have blanked the bundle.
 */
function makeEnv() {
  const assetFetch = vi.fn(
    async (request: Request) =>
      new Response(`asset:${new URL(request.url).pathname}`, { status: 200 })
  );
  const kvGet = vi.fn(async () => null);
  const env = {
    ASSETS: { fetch: assetFetch },
    SESSIONS: { get: kvGet },
  } as unknown as Env;
  return { env, assetFetch, kvGet };
}

const request = (path: string, method = "GET") =>
  new Request(`https://agent.openaimp.com${path}`, { method });

const ASSET_PATHS = [
  "/assets/index-abc123.js",
  "/assets/index-abc123.css",
  "/strategies/iron_condor.html",
  "/favicon.ico",
  "/robots.txt",
];

describe("static asset bypass (issue #329)", () => {
  it.each(ASSET_PATHS)("serves %s from ASSETS with no SESSIONS read", async (path) => {
    const { env, assetFetch, kvGet } = makeEnv();

    const res = await serveStaticAsset(request(path), path, env);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe(`asset:${path}`);
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("answers HEAD for an asset without a SESSIONS read", async () => {
    const { env, assetFetch, kvGet } = makeEnv();

    await serveStaticAsset(request("/assets/app.js", "HEAD"), "/assets/app.js", env);

    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it.each([
    "/",
    "/index.html",
    "/dashboard",
    "/api/nlq",
    "/assetsx/app.js",
    "/strategies",
    "/favicon.ico/extra",
  ])("does not bypass auth for %s", async (path) => {
    const { env, assetFetch } = makeEnv();

    const res = await serveStaticAsset(request(path), path, env);

    expect(res).toBeNull();
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("does not bypass auth for non-GET/HEAD asset paths", async () => {
    const { env, assetFetch } = makeEnv();

    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await serveStaticAsset(request("/assets/app.js", method), "/assets/app.js", env);
      expect(res).toBeNull();
    }
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("keeps the predicate and the server response in agreement", () => {
    for (const path of ASSET_PATHS) {
      expect(isStaticAssetRequest(request(path), path)).toBe(true);
    }
    expect(isStaticAssetRequest(request("/api/nlq"), "/api/nlq")).toBe(false);
  });
});
