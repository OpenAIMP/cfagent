/**
 * Issue #2071: idempotent schedule creation.
 *
 * The create form is a plain POST; a double click, a retried request, or a
 * second tab submitting the same form armed a second identical schedule
 * (interval schedules are not idempotent at the SDK layer, and cron
 * idempotency only covers identical cron registrations). The page then
 * showed the same schedule twice.
 *
 * This module owns the one comparison used by the route: same callback,
 * same payload (order-insensitive), same cadence. It is deliberately
 * conservative — a field the new request does not specify is ignored, a
 * field it does specify must match — so distinct schedules are never
 * collapsed into one.
 */

/** Stable JSON for deep equality (object keys sorted, arrays in order). */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node as object)) return "[circular]";
    seen.add(node as object);
    if (Array.isArray(node)) return node.map(walk);
    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = walk(record[key]);
    return out;
  };
  try {
    return JSON.stringify(walk(value ?? null));
  } catch {
    return String(value);
  }
}

/** Cadence fields a create request specifies. Absent fields are not compared. */
export interface ScheduleCadence {
  type?: unknown;
  cron?: unknown;
  intervalSeconds?: unknown;
  delayInSeconds?: unknown;
  /** One-off run time (the SDK list row stores it as `time`). */
  date?: unknown;
}

/**
 * The already-armed schedule this request duplicates, or undefined.
 * Compares callback + payload, then every cadence field the request names.
 */
export function findDuplicateSchedule<T extends Record<string, any>>(
  schedules: readonly T[],
  callback: string,
  payload: unknown,
  cadence: ScheduleCadence,
): T | undefined {
  const wantedPayload = canonicalJson(payload ?? null);
  return schedules.find((schedule) => {
    if (!schedule || schedule.callback !== callback) return false;
    if (canonicalJson(schedule.payload ?? null) !== wantedPayload) return false;
    if (cadence.type !== undefined && schedule.type !== cadence.type) return false;
    if (cadence.cron !== undefined && schedule.cron !== cadence.cron) return false;
    if (cadence.intervalSeconds !== undefined && schedule.intervalSeconds !== cadence.intervalSeconds) return false;
    if (cadence.delayInSeconds !== undefined && schedule.delayInSeconds !== cadence.delayInSeconds) return false;
    if (cadence.date !== undefined && schedule.time !== undefined && schedule.time !== cadence.date) return false;
    return true;
  });
}
