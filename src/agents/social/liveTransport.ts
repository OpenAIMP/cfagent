/**
 * #1250 — production live transport for platform publishing.
 *
 * The publisher layer (publisher.ts) takes an injected SocialTransport
 * and never calls fetch itself. Tests inject fakes; production used to
 * inject nothing, so a live publish failed honestly with "no transport
 * provided for live publish". This module supplies the production
 * transport: one POST over fetch, exactly the url/headers/body the
 * per-channel publisher defs supply — nothing added, rewritten, or
 * logged (headers carry bearer tokens and must never be logged).
 *
 * Mapping contract, matching the publisher's never-throws mapping:
 * - 2xx and non-2xx alike return { status, body }: the publisher turns
 *   non-2xx into an error result. A failed live gate is an error
 *   entry, never a silent dry-run fallback.
 * - A network rejection propagates: the publisher catches it and maps
 *   it to an error result.
 * - The body is JSON-parsed when possible (the publisher's post-id
 *   extractors read object bodies); unparseable bodies pass through
 *   as text, empty bodies as null.
 *
 * The fetch implementation is injectable for tests; production passes
 * none and gets globalThis.fetch (the Workers runtime fetch). This
 * transport grants nothing by itself: every gate (posting kill switch,
 * live flag, token presence, approval standing) still runs in the
 * publisher/executor before any call reaches it.
 */

import type { SocialTransport, SocialTransportResponse } from "./publisher";

/** Minimal fetch shape the transport needs (a subset of global fetch). */
export type LiveFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export function createFetchSocialTransport(
  fetchFn: LiveFetchFn = globalThis.fetch as unknown as LiveFetchFn,
): SocialTransport {
  return {
    async post(url, headers, body): Promise<SocialTransportResponse> {
      const res = await fetchFn(url, { method: "POST", headers, body });
      const text = await res.text();
      let parsed: unknown;
      if (text === "") {
        parsed = null;
      } else {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, body: parsed };
    },
  };
}
