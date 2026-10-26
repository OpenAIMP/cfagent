/**
 * Issue #1743 — composition root for the observability ports.
 * This is the ONLY module that maps the Worker environment to
 * an observability sink: domain code imports this helper and
 * the port types, never a binding.
 *
 * Absence of the binding is a normal, non-error state:
 * unbound returns the console sink (local logging), exactly
 * the issue's degradation criterion — Analytics Engine
 * unavailability never fails the request. The in-memory
 * adapter is constructed explicitly by its users (tests,
 * local development), never here.
 */
import { AnalyticsEngineObservabilityAdapter } from "./cfAnalyticsEngineAdapter";
import {
  ConsoleObservabilitySink,
  SafeObservabilitySink,
  type ObservabilitySink,
} from "./observabilityPorts";

function asDataset(value: unknown): {
  writeDataPoint: (point: {
    indexes?: ((ArrayBuffer | string) | null)[];
    doubles?: number[];
    blobs?: ((ArrayBuffer | string) | null)[];
  }) => void;
} | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { writeDataPoint?: unknown }).writeDataPoint === "function"
  ) {
    return value as {
      writeDataPoint: (point: {
        indexes?: ((ArrayBuffer | string) | null)[];
        doubles?: number[];
        blobs?: ((ArrayBuffer | string) | null)[];
      }) => void;
    };
  }
  return null;
}

/** Build the observability sink from Worker env (always a sink, never null). */
export function createObservabilitySink(env: {
  OBSERVABILITY?: unknown;
}): ObservabilitySink {
  const dataset = asDataset(env.OBSERVABILITY);
  if (!dataset) return new ConsoleObservabilitySink();
  return new SafeObservabilitySink(
    new AnalyticsEngineObservabilityAdapter(dataset),
  );
}
