/**
 * Issue #319 (amendment 2) — run entry points as thin triggers.
 *
 * The manual route and the scheduled tick both invoke the SAME publish
 * entry with only the trigger source differing. Zero duplicated
 * screening/validation/report logic between them.
 */

import type { TriggerSource } from "./researchPipeline";

export type PublishEntry<R> = (
  trigger: TriggerSource,
  userLogin?: string
) => Promise<R>;

/** Thin trigger for the manual run route. */
export function triggerManualResearch<R>(
  publish: PublishEntry<R>,
  userLogin?: string
): Promise<R> {
  return publish("manual", userLogin);
}

/** Thin trigger for the scheduled tick (server.ts cron). */
export function triggerScheduledResearch<R>(
  publish: PublishEntry<R>,
  userLogin = "default"
): Promise<R> {
  return publish("scheduled", userLogin);
}
