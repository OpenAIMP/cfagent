/**
 * Issue #107: cron timezone bugs.
 *
 * Cron expressions in the Agents SDK run in UTC, but the schedule
 * presets are labelled in Eastern Time. These tests pin the ET → UTC
 * conversion helper (src/client/options/cronTime.ts) in BOTH DST
 * regimes, using injected reference dates so the expectations do not
 * depend on when the suite runs. They also pin the token-renewal
 * invariant: the registered renewal cron ("0 3 * * *" UTC) must fire
 * at least 1 hour before the midnight-ET token expiry in both regimes
 * (23:00 EDT / 22:00 EST) — the requirement is the margin, not an
 * exact ET hour, because no static UTC cron can track ET across DST.
 */
import { describe, it, expect } from "vitest";
import {
  etToUtcCron,
  newYorkOffsetMinutes,
  timeZoneOffsetMinutes,
} from "../src/client/options/cronTime";

// Midday-UTC reference instants squarely inside each regime.
const EST_REF = new Date("2026-01-15T17:00:00.000Z"); // Thu, NY = 12:00 EST
const EDT_REF = new Date("2026-07-15T16:00:00.000Z"); // Wed, NY = 12:00 EDT

describe("timeZoneOffsetMinutes / newYorkOffsetMinutes", () => {
  it("derives the EST offset (-300) from a winter reference date", () => {
    expect(newYorkOffsetMinutes(EST_REF)).toBe(-300);
  });

  it("derives the EDT offset (-240) from a summer reference date", () => {
    expect(newYorkOffsetMinutes(EDT_REF)).toBe(-240);
  });

  it("derives UTC's offset as 0", () => {
    expect(timeZoneOffsetMinutes("UTC", EST_REF)).toBe(0);
    expect(timeZoneOffsetMinutes("UTC", EDT_REF)).toBe(0);
  });

  it("flips offset across the 2026 DST transition days", () => {
    // Spring forward: 2026-03-08 02:00 EST -> 03:00 EDT.
    expect(newYorkOffsetMinutes(new Date("2026-03-08T17:00:00.000Z"))).toBe(-240);
    expect(newYorkOffsetMinutes(new Date("2026-03-07T17:00:00.000Z"))).toBe(-300);
    // Fall back: 2026-11-01 02:00 EDT -> 01:00 EST.
    expect(newYorkOffsetMinutes(new Date("2026-11-01T17:00:00.000Z"))).toBe(-300);
    expect(newYorkOffsetMinutes(new Date("2026-10-31T16:00:00.000Z"))).toBe(-240);
  });
});

describe("etToUtcCron — the ScheduledOptionsManager presets", () => {
  it("Market Open 9:30 AM ET M-F: 13:30 UTC under EDT, 14:30 UTC under EST", () => {
    const intent = { hour: 9, minute: 30, daysOfWeek: "1-5" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("30 13 * * 1-5");
    expect(etToUtcCron(intent, EST_REF)).toBe("30 14 * * 1-5");
  });

  it("Midday Scan 12:00 PM ET M-F: 16:00 UTC under EDT, 17:00 UTC under EST", () => {
    const intent = { hour: 12, minute: 0, daysOfWeek: "1-5" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 16 * * 1-5");
    expect(etToUtcCron(intent, EST_REF)).toBe("0 17 * * 1-5");
  });

  it("Market Close 4:00 PM ET M-F: 20:00 UTC under EDT, 21:00 UTC under EST", () => {
    const intent = { hour: 16, minute: 0, daysOfWeek: "1-5" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 20 * * 1-5");
    expect(etToUtcCron(intent, EST_REF)).toBe("0 21 * * 1-5");
  });

  it("Daily Overnight 11:00 PM ET: 03:00 UTC next day under EDT, 04:00 UTC under EST", () => {
    const intent = { hour: 23, minute: 0, daysOfWeek: "*" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 3 * * *");
    expect(etToUtcCron(intent, EST_REF)).toBe("0 4 * * *");
  });
});

describe("etToUtcCron — weekday handling when the UTC time rolls to the next day", () => {
  it("shifts a weekday range by one day on rollover", () => {
    // 23:00 ET Mon-Fri is 03:00/04:00 UTC Tue-Sat.
    const intent = { hour: 23, minute: 0, daysOfWeek: "1-5" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 3 * * 2-6");
    expect(etToUtcCron(intent, EST_REF)).toBe("0 4 * * 2-6");
  });

  it("shifts and re-compresses a weekday list on rollover", () => {
    // Weekend 23:00 ET is 03:00 UTC Sun+Mon under EDT: {6,0} -> {0,1}.
    const intent = { hour: 23, minute: 0, daysOfWeek: "0,6" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 3 * * 0-1");
  });

  it("keeps a full-week field as * even on rollover", () => {
    const intent = { hour: 23, minute: 0, daysOfWeek: "0-6" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("0 3 * * *");
  });

  it("accepts 7 as Sunday and does not shift when there is no rollover", () => {
    const intent = { hour: 9, minute: 30, daysOfWeek: "7" };
    expect(etToUtcCron(intent, EDT_REF)).toBe("30 13 * * 0");
  });

  it("does not roll early-morning ET times into the previous UTC day", () => {
    const intent = { hour: 0, minute: 30 };
    expect(etToUtcCron(intent, EDT_REF)).toBe("30 4 * * *");
    expect(etToUtcCron(intent, EST_REF)).toBe("30 5 * * *");
  });

  it("defaults the day-of-week field to * when omitted", () => {
    expect(etToUtcCron({ hour: 9, minute: 30 }, EDT_REF)).toBe("30 13 * * *");
  });
});

describe("etToUtcCron — validation", () => {
  it("rejects out-of-range hours and minutes", () => {
    expect(() => etToUtcCron({ hour: 24, minute: 0 }, EDT_REF)).toThrow(RangeError);
    expect(() => etToUtcCron({ hour: 9, minute: 60 }, EDT_REF)).toThrow(RangeError);
  });

  it("rejects day-of-week grammar it cannot shift exactly", () => {
    expect(() => etToUtcCron({ hour: 9, minute: 0, daysOfWeek: "*/2" }, EDT_REF)).toThrow(RangeError);
    expect(() => etToUtcCron({ hour: 9, minute: 0, daysOfWeek: "1-8" }, EDT_REF)).toThrow(RangeError);
    expect(() => etToUtcCron({ hour: 9, minute: 0, daysOfWeek: "MON" }, EDT_REF)).toThrow(RangeError);
  });
});

describe("token-renewal cron invariant (orchestrator onStart registers '0 3 * * *')", () => {
  it("the registered expression is the EDT-regime conversion of the 23:00 ET intent", () => {
    expect(etToUtcCron({ hour: 23, minute: 0 }, EDT_REF)).toBe("0 3 * * *");
  });

  it("fires at 23:00 ET under EDT and 22:00 ET under EST", () => {
    // ET wall-clock hour of a 03:00 UTC firing, from each regime's offset.
    const etHour = (ref: Date) => (3 + newYorkOffsetMinutes(ref) / 60 + 24) % 24;
    expect(etHour(EDT_REF)).toBe(23);
    expect(etHour(EST_REF)).toBe(22);
  });

  it("leaves at least 60 minutes before the midnight-ET expiry in both regimes", () => {
    const marginMinutes = (ref: Date) => {
      const etHour = (3 + newYorkOffsetMinutes(ref) / 60 + 24) % 24;
      return (24 - etHour) * 60;
    };
    expect(marginMinutes(EDT_REF)).toBe(60);
    expect(marginMinutes(EST_REF)).toBe(120);
    expect(marginMinutes(EDT_REF)).toBeGreaterThanOrEqual(60);
    expect(marginMinutes(EST_REF)).toBeGreaterThanOrEqual(60);
  });
});
