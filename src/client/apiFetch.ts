type AsyncJobStatusResponse = {
  jobId: string;
  capability: string;
  status: "queued" | "running" | "completed" | "failed";
  statusUrl: string;
  result?: unknown;
  responseStatus?: number;
  error?: string;
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const initialResponse = await globalThis.fetch(input, init);
  if (initialResponse.status !== 202) return initialResponse;

  let accepted: Partial<AsyncJobStatusResponse>;
  try {
    accepted = await initialResponse.clone().json() as AsyncJobStatusResponse;
  } catch {
    return initialResponse;
  }
  if (typeof accepted.jobId !== "string" || typeof accepted.statusUrl !== "string") return initialResponse;

  let delayMs = 500;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(delayMs);
    const response = await globalThis.fetch(accepted.statusUrl, { headers: { "Accept": "application/json" } });
    if (!response.ok) return response;
    const job = await response.json() as AsyncJobStatusResponse;
    if (job.status === "failed") {
      return Response.json(
        { error: job.error || "Asynchronous request failed.", jobId: job.jobId, status: job.status },
        { status: 500 },
      );
    }
    if (job.status === "completed") {
      if (job.capability === "http.request") {
        const result = job.result as { body?: string; headers?: Record<string, string> } | undefined;
        const status = job.responseStatus || 200;
        return new Response(status === 204 || status === 304 ? null : result?.body || "", {
          status,
          headers: result?.headers,
        });
      }
      return Response.json(job.result, { status: job.responseStatus || 200 });
    }
    delayMs = Math.min(Math.round(delayMs * 1.5), 5_000);
  }

  return Response.json(
    {
      error: "The request is still processing. The job will continue in the background.",
      jobId: accepted.jobId,
      statusUrl: accepted.statusUrl,
    },
    { status: 408 },
  );
}
