import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/client/apiFetch";

describe("apiFetch async job compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ordinary responses without polling", async () => {
    const nativeFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", nativeFetch);

    const response = await apiFetch("/api/jobs");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("polls a queued HTTP job and reconstructs the original response", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: "job-1", status: "queued", statusUrl: "/api/jobs/job-1" },
        { status: 202 },
      ))
      .mockResolvedValueOnce(Response.json({
        jobId: "job-1",
        capability: "http.request",
        status: "completed",
        responseStatus: 201,
        result: { body: JSON.stringify({ created: true }), headers: { "content-type": "application/json" } },
      }));
    vi.stubGlobal("fetch", nativeFetch);

    const responsePromise = apiFetch("/api/example", { method: "POST" });
    await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const response = await responsePromise;

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
  });

  it("surfaces a failed background job as an explicit error response", async () => {
    const nativeFetch = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: "job-2", status: "queued", statusUrl: "/api/jobs/job-2" },
        { status: 202 },
      ))
      .mockResolvedValueOnce(Response.json({
        jobId: "job-2",
        capability: "http.request",
        status: "failed",
        error: "Provider unavailable",
      }));
    vi.stubGlobal("fetch", nativeFetch);

    const responsePromise = apiFetch("/api/example");
    await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const response = await responsePromise;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job-2", error: "Provider unavailable" });
  });
});
