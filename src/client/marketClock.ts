/**
 * Market Clock & US Equity Market Status Engine
 *
 * Evaluates US Equity market hours (NYSE / NASDAQ) dynamically in Eastern Time (ET)
 * accounting for Eastern Standard Time (EST) and Eastern Daylight Time (EDT) automatically.
 *
 * Regular Trading Hours (RTH): Monday - Friday 09:30 - 16:00 ET (excluding market holidays).
 * Pre-Market: 07:00 - 09:30 ET.
 * After-Hours: 16:00 - 20:00 ET.
 */

import { useState, useEffect } from "react";

export type MarketPhase = "open" | "pre" | "post" | "closed" | "holiday";

export interface MarketStatus {
  isOpen: boolean;
  phase: MarketPhase;
  text: string;
  dotClass: "open" | "closed";
  easternTimeFormatted: string;
}

/**
 * Observed US Market Holidays (NYSE & NASDAQ closures) for 2024–2028.
 */
const KNOWN_US_MARKET_HOLIDAYS = new Set<string>([
  // 2024
  "2024-01-01", // New Year's Day
  "2024-01-15", // Martin Luther King Jr. Day
  "2024-02-19", // Washington's Birthday / Presidents' Day
  "2024-03-29", // Good Friday
  "2024-05-27", // Memorial Day
  "2024-06-19", // Juneteenth
  "2024-07-04", // Independence Day
  "2024-09-02", // Labor Day
  "2024-11-28", // Thanksgiving Day
  "2024-12-25", // Christmas Day

  // 2025
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Jr. Day
  "2025-02-17", // Presidents' Day
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving Day
  "2025-12-25", // Christmas Day

  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Presidents' Day
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (Observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day

  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Jr. Day
  "2027-02-15", // Presidents' Day
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (Observed)
  "2027-07-05", // Independence Day (Observed)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (Observed)

  // 2028
  "2028-01-17", // MLK Jr. Day
  "2028-02-21", // Presidents' Day
  "2028-04-14", // Good Friday
  "2028-05-29", // Memorial Day
  "2028-06-19", // Juneteenth
  "2028-07-04", // Independence Day
  "2028-09-04", // Labor Day
  "2028-11-23", // Thanksgiving Day
  "2028-12-25", // Christmas Day
]);

/**
 * Extracts Eastern Time calendar & clock components using browser Intl API.
 */
export function getEasternTimeParts(targetDate: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(targetDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  const weekday = map.weekday; // "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"

  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);

  const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const totalMinutes = hour * 60 + minute;
  const easternTimeFormatted = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")} ET`;

  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    second,
    isoDate,
    totalMinutes,
    easternTimeFormatted,
  };
}

/**
 * Evaluates the current market status given a date.
 */
export function getMarketStatus(now: Date = new Date()): MarketStatus {
  const et = getEasternTimeParts(now);

  // Check Weekend
  if (et.weekday === "Sat" || et.weekday === "Sun") {
    return {
      isOpen: false,
      phase: "closed",
      text: "Market CLOSED · opens Mon 09:30 ET",
      dotClass: "closed",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // Check Holiday
  if (KNOWN_US_MARKET_HOLIDAYS.has(et.isoDate)) {
    const nextOpen = et.weekday === "Fri" ? "Mon 09:30 ET" : "tomorrow 09:30 ET";
    return {
      isOpen: false,
      phase: "holiday",
      text: `Market CLOSED · Holiday (opens ${nextOpen})`,
      dotClass: "closed",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // Regular Trading Hours: 09:30 - 16:00 ET (570m to 960m)
  if (et.totalMinutes >= 570 && et.totalMinutes < 960) {
    return {
      isOpen: true,
      phase: "open",
      text: "Market OPEN · closes 16:00 ET",
      dotClass: "open",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // Pre-Market: 07:00 - 09:30 ET (420m to 570m)
  if (et.totalMinutes >= 420 && et.totalMinutes < 570) {
    return {
      isOpen: false,
      phase: "pre",
      text: "Pre-Market · opens 09:30 ET",
      dotClass: "closed",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // After-Hours: 16:00 - 20:00 ET (960m to 1200m)
  if (et.totalMinutes >= 960 && et.totalMinutes < 1200) {
    return {
      isOpen: false,
      phase: "post",
      text: "After Hours · closed",
      dotClass: "closed",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // Early morning before 07:00 ET
  if (et.totalMinutes < 420) {
    return {
      isOpen: false,
      phase: "closed",
      text: "Market CLOSED · opens today 09:30 ET",
      dotClass: "closed",
      easternTimeFormatted: et.easternTimeFormatted,
    };
  }

  // Late night after 20:00 ET
  const nextOpenDay = et.weekday === "Fri" ? "Mon 09:30 ET" : "tomorrow 09:30 ET";
  return {
    isOpen: false,
    phase: "closed",
    text: `Market CLOSED · opens ${nextOpenDay}`,
    dotClass: "closed",
    easternTimeFormatted: et.easternTimeFormatted,
  };
}

/**
 * React hook that returns live updating market status.
 * Re-evaluates every `refreshIntervalMs` (default: 15 seconds).
 */
export function useMarketStatus(refreshIntervalMs = 15000): MarketStatus {
  const [status, setStatus] = useState<MarketStatus>(() => getMarketStatus());

  useEffect(() => {
    setStatus(getMarketStatus());
    const interval = setInterval(() => {
      setStatus(getMarketStatus());
    }, refreshIntervalMs);

    return () => clearInterval(interval);
  }, [refreshIntervalMs]);

  return status;
}
