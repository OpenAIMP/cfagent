/**
 * #1077 Phase 4 — daily fire check for the social posting schedule.
 *
 * Pure and unit-testable: every function takes nowMs explicitly and
 * never reads Date.now() itself, so tests pin exact instants. All
 * wall-clock math is America/New_York, using the same en-CA Intl idiom
 * the codebase already uses for ET dates (src/security/etradeOAuth.ts,
 * src/trading/options/ivHistoryStore.ts).
 *
 * Semantics: a day is "due" when its weekday is in the schedule AND the
 * NY wall-clock time has reached the posting time. The check does NOT
 * require the tick to land exactly on the posting time — the worker tick
 * runs every 30 minutes, so a tick at 09:00 or 09:30 must both count as
 * due. Duplicate firing is prevented separately: shouldFire is false
 * whenever the ledger already holds a draft-set for today, which is what
 * makes a tick replay produce exactly one draft-set per day.
 *
 * CONFIGURABLE DEFAULTS (pending owner confirmation, #1077): posting
 * time 09:00 America/New_York, weekdays Monday–Friday. These are the
 * defaults only; the schedule is an input, not a constant, so the owner
 * changes time/weekdays without a code change.
 */

import type { SocialLedger } from "./ledger";

/** Weekday convention: 0 = Sunday … 6 = Saturday (JS Date convention). */
export interface SocialSchedule {
  /** HH:MM, 24-hour, America/New_York wall-clock time. */
  time: string;
  weekdays: number[];
  timeZone: "America/New_York";
}

export const DEFAULT_SOCIAL_SCHEDULE: SocialSchedule = {
  time: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  timeZone: "America/New_York",
};

export interface NyParts {
  /** YYYY-MM-DD in America/New_York. */
  date: string;
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** America/New_York wall-clock parts of an instant. Pure. */
export function nyParts(nowMs: number): NyParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_NAMES.indexOf(get("weekday") as (typeof WEEKDAY_NAMES)[number]);
  const month = get("month");
  const day = get("day");
  const year = get("year");
  return {
    date: `${year}-${month}-${day}`,
    weekday,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(":");
  return { hour: Number(h), minute: Number(m) };
}

export interface DailyFireCheck {
  date: string;
  /** Weekday is scheduled and the posting time has been reached. */
  due: boolean;
  /** The ledger already holds at least one draft for today. */
  alreadyExists: boolean;
  /** due && !alreadyExists — the only case that may build a draft-set. */
  shouldFire: boolean;
}

export function checkDailyFire(input: {
  nowMs: number;
  schedule: SocialSchedule;
  ledger: SocialLedger;
}): DailyFireCheck {
  const parts = nyParts(input.nowMs);
  const { hour, minute } = parseTime(input.schedule.time);
  const timeReached = parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
  const due = input.schedule.weekdays.includes(parts.weekday) && timeReached;
  const alreadyExists = input.ledger.listDrafts(parts.date).length > 0;
  return { date: parts.date, due, alreadyExists, shouldFire: due && !alreadyExists };
}
