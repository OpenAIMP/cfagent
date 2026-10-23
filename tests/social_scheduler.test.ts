import { describe, it, expect } from "vitest";
import {
  nyParts,
  checkDailyFire,
  DEFAULT_SOCIAL_SCHEDULE,
  type SocialSchedule,
} from "../src/agents/social/scheduler";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import type { SocialDraft } from "../src/agents/social/draft";

function draft(date: string, channel = "x"): SocialDraft {
  return {
    id: `${date}-${channel}`,
    date,
    channel: channel as SocialDraft["channel"],
    text: "hi",
    status: "draft",
    createdAtMs: 0,
    originalLength: 2,
    truncated: false,
  };
}

// 2026-10-26 is a Monday; 13:00Z = 09:00 EDT. 2026-10-24/25 are Sat/Sun.
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
const MON_0830 = Date.parse("2026-10-26T12:30:00Z");
const MON_0930 = Date.parse("2026-10-26T13:30:00Z");
const SAT_1000 = Date.parse("2026-10-24T14:00:00Z");
const SUN_1000 = Date.parse("2026-10-25T14:00:00Z");

describe("NY wall-clock parts", () => {
  it("resolves a Monday 09:00 EDT instant to the right date, weekday, and time", () => {
    const parts = nyParts(MON_0900);
    expect(parts.date).toBe("2026-10-26");
    expect(parts.weekday).toBe(1);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
  });

  it("resolves weekend instants to Saturday and Sunday", () => {
    expect(nyParts(SAT_1000).weekday).toBe(6);
    expect(nyParts(SUN_1000).weekday).toBe(0);
  });
});

describe("daily fire check", () => {
  const schedule: SocialSchedule = DEFAULT_SOCIAL_SCHEDULE;

  it("exposes the configurable defaults (09:00 NY, Mon–Fri)", () => {
    expect(DEFAULT_SOCIAL_SCHEDULE.time).toBe("09:00");
    expect(DEFAULT_SOCIAL_SCHEDULE.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_SOCIAL_SCHEDULE.timeZone).toBe("America/New_York");
  });

  it("is due exactly at the posting time on a weekday", () => {
    const res = checkDailyFire({ nowMs: MON_0900, schedule, ledger: new MemorySocialLedger() });
    expect(res.due).toBe(true);
    expect(res.shouldFire).toBe(true);
    expect(res.date).toBe("2026-10-26");
  });

  it("is due on a later 30-minute tick the same morning", () => {
    const res = checkDailyFire({ nowMs: MON_0930, schedule, ledger: new MemorySocialLedger() });
    expect(res.due).toBe(true);
    expect(res.shouldFire).toBe(true);
  });

  it("is not due before the posting time", () => {
    const res = checkDailyFire({ nowMs: MON_0830, schedule, ledger: new MemorySocialLedger() });
    expect(res.due).toBe(false);
    expect(res.shouldFire).toBe(false);
  });

  it("is not due on weekends even after the posting time", () => {
    for (const nowMs of [SAT_1000, SUN_1000]) {
      const res = checkDailyFire({ nowMs, schedule, ledger: new MemorySocialLedger() });
      expect(res.due).toBe(false);
      expect(res.shouldFire).toBe(false);
    }
  });

  it("does not fire twice when a draft-set already exists today", () => {
    const ledger = new MemorySocialLedger();
    ledger.putDraft(draft("2026-10-26"));
    const res = checkDailyFire({ nowMs: MON_0900, schedule, ledger });
    expect(res.due).toBe(true);
    expect(res.alreadyExists).toBe(true);
    expect(res.shouldFire).toBe(false);
  });

  it("respects a custom schedule time and weekdays", () => {
    const custom: SocialSchedule = { time: "18:30", weekdays: [6], timeZone: "America/New_York" };
    const satEvening = Date.parse("2026-10-24T22:30:00Z"); // 18:30 EDT Saturday
    const res = checkDailyFire({ nowMs: satEvening, schedule: custom, ledger: new MemorySocialLedger() });
    expect(res.due).toBe(true);
    expect(res.shouldFire).toBe(true);
    const mon = checkDailyFire({ nowMs: MON_0900, schedule: custom, ledger: new MemorySocialLedger() });
    expect(mon.due).toBe(false);
  });
});
