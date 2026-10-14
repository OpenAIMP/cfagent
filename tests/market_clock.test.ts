import { describe, it, expect } from "vitest";
import { getMarketStatus, getEasternTimeParts } from "../src/client/marketClock";

describe("Market Clock & US Equity Market Status Engine", () => {
  it("detects regular trading hours (Market OPEN: Mon-Fri 09:30-16:00 ET)", () => {
    // Wednesday 2026-10-14 09:38:00 EDT (UTC 13:38:00)
    const midOpen = new Date("2026-10-14T13:38:00Z");
    const status = getMarketStatus(midOpen);

    expect(status.isOpen).toBe(true);
    expect(status.phase).toBe("open");
    expect(status.dotClass).toBe("open");
    expect(status.text).toBe("Market OPEN · closes 16:00 ET");
  });

  it("detects pre-market hours (07:00-09:30 ET)", () => {
    // Wednesday 2026-10-14 08:15:00 EDT (UTC 12:15:00)
    const preMarket = new Date("2026-10-14T12:15:00Z");
    const status = getMarketStatus(preMarket);

    expect(status.isOpen).toBe(false);
    expect(status.phase).toBe("pre");
    expect(status.dotClass).toBe("closed");
    expect(status.text).toBe("Pre-Market · opens 09:30 ET");
  });

  it("detects after-hours trading (16:00-20:00 ET)", () => {
    // Wednesday 2026-10-14 17:30:00 EDT (UTC 21:30:00)
    const afterHours = new Date("2026-10-14T21:30:00Z");
    const status = getMarketStatus(afterHours);

    expect(status.isOpen).toBe(false);
    expect(status.phase).toBe("post");
    expect(status.dotClass).toBe("closed");
    expect(status.text).toBe("After Hours · closed");
  });

  it("detects weekend closure (Saturday)", () => {
    // Saturday 2026-10-17 12:00:00 EDT (UTC 16:00:00)
    const weekend = new Date("2026-10-17T16:00:00Z");
    const status = getMarketStatus(weekend);

    expect(status.isOpen).toBe(false);
    expect(status.phase).toBe("closed");
    expect(status.dotClass).toBe("closed");
    expect(status.text).toBe("Market CLOSED · opens Mon 09:30 ET");
  });

  it("detects weekend closure (Sunday)", () => {
    // Sunday 2026-10-18 12:00:00 EDT (UTC 16:00:00)
    const weekend = new Date("2026-10-18T16:00:00Z");
    const status = getMarketStatus(weekend);

    expect(status.isOpen).toBe(false);
    expect(status.phase).toBe("closed");
    expect(status.dotClass).toBe("closed");
    expect(status.text).toBe("Market CLOSED · opens Mon 09:30 ET");
  });

  it("detects US holiday closure (e.g., Thanksgiving)", () => {
    // Thursday 2026-11-26 12:00:00 EST (UTC 17:00:00)
    const holiday = new Date("2026-11-26T17:00:00Z");
    const status = getMarketStatus(holiday);

    expect(status.isOpen).toBe(false);
    expect(status.phase).toBe("holiday");
    expect(status.dotClass).toBe("closed");
    expect(status.text).toContain("Market CLOSED · Holiday");
  });

  it("correctly extracts Eastern Time components", () => {
    // 2026-10-14 09:39:00 EDT (UTC 13:39:00)
    const testDate = new Date("2026-10-14T13:39:00Z");
    const et = getEasternTimeParts(testDate);

    expect(et.year).toBe(2026);
    expect(et.month).toBe(10);
    expect(et.day).toBe(14);
    expect(et.weekday).toBe("Wed");
    expect(et.hour).toBe(9);
    expect(et.minute).toBe(39);
    expect(et.totalMinutes).toBe(579);
  });
});
