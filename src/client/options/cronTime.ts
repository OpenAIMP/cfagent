/**
 * Eastern-Time intent → UTC cron conversion (issue #107).
 *
 * Cron expressions in the Agents SDK are interpreted in UTC, but the
 * schedule presets in ScheduledOptionsManager are labelled with Eastern
 * wall-clock times ("Market Open (9:30 AM ET M-F)"). Writing the ET
 * numbers straight into a cron string — the old behaviour — made every
 * preset fire 4–5 hours early.
 *
 * The honest limitation: a single static UTC cron can NEVER track an ET
 * wall-clock time across DST, because the ET offset changes twice a
 * year (-4 EDT / -5 EST). This helper therefore converts using the
 * America/New_York offset in effect at a reference date (default: now)
 * — i.e. the preset fires at its labelled ET time in the current DST
 * regime, and after the spring/autumn clock change a saved schedule
 * shifts by one hour until it is re-saved. The UI discloses this next
 * to the presets; nothing here pretends the problem away.
 *
 * No dependencies: the offset is derived from Intl.DateTimeFormat with
 * an explicit timeZone, never from a hand-picked -4/-5 constant.
 */

export const NEW_YORK_TIME_ZONE = "America/New_York";

/**
 * Offset of `timeZone` from UTC, in minutes (negative west of UTC), at
 * the instant `at`. Derived by formatting `at` in the zone and
 * comparing the wall-clock reading against the instant itself.
 */
export function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // hourCycle "h23" yields 0-23; the % 24 guards ICU builds that emit 24.
  const wallAsUtcMs = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
  const atMs = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((wallAsUtcMs - atMs) / 60000);
}

/** America/New_York offset from UTC in minutes at `at` (-240 EDT, -300 EST). */
export function newYorkOffsetMinutes(at: Date): number {
  return timeZoneOffsetMinutes(NEW_YORK_TIME_ZONE, at);
}

/** An Eastern wall-clock time a schedule should fire at. */
export interface EtCronIntent {
  /** Hour of day in America/New_York, 0-23. */
  hour: number;
  /** Minute of hour in America/New_York, 0-59. */
  minute: number;
  /**
   * Cron day-of-week field as an ET intent: "*", or a comma list of
   * single days ("0,6") and ranges ("1-5"); day numbers 0-6, with 7
   * accepted as Sunday. Steps ("*\/2") and names are rejected — the
   * weekday set must be shifted as a set when the UTC conversion rolls
   * into the next day, which only this grammar supports exactly.
   * Defaults to "*".
   */
  daysOfWeek?: string;
}

function parseDaysOfWeek(spec: string): Set<number> {
  const days = new Set<number>();
  for (const item of spec.split(",")) {
    const trimmed = item.trim();
    const range = /^(\d)-(\d)$/.exec(trimmed);
    const single = /^(\d)$/.exec(trimmed);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > 7 || to > 7 || from > to) {
        throw new RangeError(`Unsupported day-of-week range: "${item}"`);
      }
      for (let d = from; d <= to; d++) days.add(d % 7);
    } else if (single) {
      const d = Number(single[1]);
      if (d > 7) throw new RangeError(`Unsupported day-of-week value: "${item}"`);
      days.add(d % 7);
    } else {
      throw new RangeError(`Unsupported day-of-week field: "${spec}"`);
    }
  }
  return days;
}

function renderDaysOfWeek(days: Set<number>): string {
  if (days.size === 7) return "*";
  const sorted = [...days].sort((a, b) => a - b);
  const rendered: string[] = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  const flush = () => {
    rendered.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`);
  };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      flush();
      runStart = prev = sorted[i];
    }
  }
  flush();
  return rendered.join(",");
}

function shiftDaysOfWeek(spec: string, dayShift: number): string {
  const shift = ((dayShift % 7) + 7) % 7;
  if (spec.trim() === "*") return "*";
  const days = parseDaysOfWeek(spec);
  if (shift === 0) return renderDaysOfWeek(days);
  return renderDaysOfWeek(new Set([...days].map((d) => (d + shift) % 7)));
}

/**
 * Build the UTC cron expression that fires at the given America/New_York
 * wall-clock time, using the New York offset in effect at
 * `referenceDate` (default: now). See the module header for the DST
 * caveat this cannot escape.
 */
export function etToUtcCron(intent: EtCronIntent, referenceDate: Date = new Date()): string {
  if (!Number.isInteger(intent.hour) || intent.hour < 0 || intent.hour > 23) {
    throw new RangeError(`ET hour must be an integer 0-23, got ${intent.hour}`);
  }
  if (!Number.isInteger(intent.minute) || intent.minute < 0 || intent.minute > 59) {
    throw new RangeError(`ET minute must be an integer 0-59, got ${intent.minute}`);
  }
  const offsetMinutes = newYorkOffsetMinutes(referenceDate);
  const totalMinutes = intent.hour * 60 + intent.minute - offsetMinutes;
  const dayShift = Math.floor(totalMinutes / 1440);
  const utcMinutes = ((totalMinutes % 1440) + 1440) % 1440;
  const utcHour = Math.floor(utcMinutes / 60);
  const utcMinute = utcMinutes % 60;
  const days = shiftDaysOfWeek(intent.daysOfWeek ?? "*", dayShift);
  return `${utcMinute} ${utcHour} * * ${days}`;
}
