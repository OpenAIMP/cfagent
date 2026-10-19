import { useEffect, useRef } from "react";
import { startPolling, type PollSchedule } from "./polling";

/**
 * React wrapper around `startPolling` (issue #329, P1).
 *
 * Callbacks are held in refs so a re-render never restarts the schedule — only
 * the cadences do. `isBusy` is likewise read through a ref, so the poll can
 * change cadence without re-subscribing.
 */
export function usePolling(
  run: () => void | Promise<void>,
  schedule: Omit<PollSchedule, "isBusy"> & { isBusy?: () => boolean }
): void {
  const runRef = useRef(run);
  const busyRef = useRef(schedule.isBusy);
  runRef.current = run;
  busyRef.current = schedule.isBusy;

  const { fastMs, idleMs } = schedule;

  useEffect(() => {
    return startPolling(
      () => runRef.current(),
      {
        fastMs,
        idleMs,
        isBusy: busyRef.current ? () => busyRef.current?.() ?? false : undefined,
      }
    );
  }, [fastMs, idleMs]);
}
