import { isKvLimitError } from "./kvResilience";

/**
 * Last line of defence against Cloudflare error 1101.
 *
 * 1101 is what the edge returns when the Worker's fetch handler throws and
 * nothing catches it. A thrown KV quota error therefore became a site-wide
 * outage rather than a degraded response. This boundary converts any escaped
 * error into a real HTTP response with a code the UI can act on, and keeps the
 * stack in the logs instead of in the visitor's face.
 *
 * Kept free of Worker-only imports so it can be unit tested under Node.
 */
export interface ErrorBoundaryOptions {
  log?: (message: string, error: unknown) => void;
}

export interface ErrorBody {
  error: string;
  code: "kv_quota_exhausted" | "internal_error";
}

export function classifyError(error: unknown): { status: number; body: ErrorBody } {
  if (isKvLimitError(error)) {
    return {
      status: 503,
      body: {
        error:
          "Session storage is temporarily unavailable. Retry shortly; reads resume automatically once the store recovers.",
        code: "kv_quota_exhausted",
      },
    };
  }
  return {
    status: 500,
    body: { error: "Internal error. The failure has been logged.", code: "internal_error" },
  };
}

export function withErrorBoundary<TEnv>(
  handler: (request: Request, env: TEnv) => Promise<Response>,
  options: ErrorBoundaryOptions = {}
): (request: Request, env: TEnv) => Promise<Response> {
  const log = options.log ?? ((message: string, error: unknown) => console.error(message, error));

  return async (request: Request, env: TEnv): Promise<Response> => {
    try {
      return await handler(request, env);
    } catch (error) {
      // A handler that throws a Response is using it as control flow (e.g. a
      // redirect helper); honour it instead of wrapping it as a 500.
      if (error instanceof Response) return error;

      const { status, body } = classifyError(error);
      const message = error instanceof Error ? error.message : String(error);
      log(`[worker] ${request.method} ${new URL(request.url).pathname} failed (${body.code}): ${message}`, error);

      return Response.json(body, {
        status,
        headers: { "Cache-Control": "no-store", "Retry-After": status === 503 ? "30" : "5" },
      });
    }
  };
}
