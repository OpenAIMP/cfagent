/**
 * Run Details (issue #2534): client-side rendering helpers for the
 * modal. Message wording lives in the server catalog
 * (src/services/runDetails.ts) and arrives resolved in the API
 * payload — this module never hardcodes a Run Details reason string.
 * Timestamps are rendered in the user's timezone with a label, never
 * as a raw epoch, a bare ISO string, or server time.
 */
import type { RunDetail } from "../services/runDetails";

export type { RunDetail };

/** User-timezone, human-readable timestamp with timezone label. */
export function formatRunDetailTimestamp(value: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "unknown";
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone || undefined,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toLocaleString(undefined, { timeZoneName: "short" });
  }
}

export type RunDetailLevelFilter = "all" | "info" | "debugging" | "error";

/** Level filter for the modal: info shows stages+request, debugging
 *  adds ids/versions/hashes/timings, error shows failures+reasons. */
export function runDetailSectionLevel(section: "request" | "provenance" | "lineage" | "stages" | "reasons"): "info" | "debugging" | "error" {
  switch (section) {
    case "request":
    case "provenance":
      return "info";
    case "lineage":
    case "stages":
      return "debugging";
    case "reasons":
      return "error";
  }
}

export function runDetailVisibleSections(filter: RunDetailLevelFilter): Array<"request" | "provenance" | "lineage" | "stages" | "reasons"> {
  const all = ["request", "provenance", "lineage", "stages", "reasons"] as const;
  if (filter === "all") return [...all];
  return all.filter((s) => runDetailSectionLevel(s) === filter);
}
