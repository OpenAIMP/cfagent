/**
 * SessionStore data-plane observability (issue #910).
 *
 * Every op against the SessionStore Durable Object flows through the single
 * client funnel in `durableKv.ts` (`createStoreClient`). That funnel emits
 * exactly one of these records per op, so the #789 sharding triggers can be
 * evaluated from Workers Logs at any time:
 *
 * - T1 (volume): >250 ops/s sustained, or >500 ops/s averaged over an hour,
 *   against the "kv" instance.
 * - T2 (failures): `failed` + `unavailable` outcomes >0.1% of ops in 24 h.
 *
 * The exact aggregation queries live in `docs/OBSERVABILITY.md` (§4).
 *
 * Why client-side records rather than a counter inside the DO: the failures
 * T2 exists to catch — client timeouts (2,000 ms budget), platform
 * *overloaded* responses, a missing binding — are precisely the ones a
 * server-side counter can never see, because the request never lands. The
 * funnel sees every outcome.
 *
 * Why one JSON log line per op: invocation logs are already enabled
 * (`wrangler.jsonc`), Cloudflare parses a JSON log message into structured
 * fields, and no extra store round-trip is added to the op path. Volume is
 * one line per op — the same order as the warn logging the failure path
 * already produced — and at today's load (≪5 ops/s, #789 §3) it is trivial.
 * If volume ever becomes the problem, aggregate in-isolate behind this same
 * sink seam; the record shape is the contract, not the transport.
 */
export type StoreOpOutcome = "ok" | "miss" | "failed" | "unavailable";

export interface StoreOpRecord {
  event: "store_op";
  v: 1;
  /** Logical bucket: "sessions", "etrade", "api_keys", "payments". */
  ns: string;
  /** Store op: "get" | "put" | "delete" | "consume" | "list". */
  op: string;
  /** DO instance the op was addressed to ("kv" today). */
  instance: string;
  outcome: StoreOpOutcome;
  /** Client-observed latency of the store round-trip, ms (0 when unavailable). */
  latencyMs: number;
  /** HTTP status, present only when the store answered with a non-200. */
  httpStatus?: number;
  /** Completion time, epoch ms. */
  ts: number;
}

export type StoreOpSink = (record: StoreOpRecord) => void;

function defaultStoreOpSink(record: StoreOpRecord): void {
  // A bare JSON line: Workers Logs lifts the fields out of the message, so
  // the record is aggregable without parsing free text.
  console.log(JSON.stringify(record));
}

let activeSink: StoreOpSink = defaultStoreOpSink;

/**
 * Replace the record sink (tests, or a future metrics transport). Pass null
 * to restore the default console.log sink.
 */
export function setStoreOpSink(sink: StoreOpSink | null): void {
  activeSink = sink ?? defaultStoreOpSink;
}

/**
 * Emit one store-op record. NEVER throws: metrics are best-effort by
 * contract — a broken sink must never become an auth bug (pinned by
 * tests/store_op_metrics.test.ts).
 */
export function recordStoreOp(record: StoreOpRecord): void {
  try {
    activeSink(record);
  } catch {
    // Swallowed deliberately: observability cannot fail the op it observes.
  }
}
