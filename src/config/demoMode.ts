/**
 * Dev/demo gate for calibrated (generated) option chains — issue #65.
 *
 * Production is live-data only: calibrated chains are NEVER served unless
 * this gate is explicitly enabled for a dev/demo deployment, AND even then
 * only on an explicit `dataMode: "calibrated-demo"` request (the Demo tab),
 * never as a silent fallback on a live path.
 *
 * Enable via either:
 *   - environment.config.json:  "demo": { "calibratedChains": true }
 *   - environment variable:     CFAGENT_DEMO_CALIBRATED_CHAINS=1 (or "true")
 * Default: disabled.
 */

import environmentConfig from "../../environment.config.json";

export function isDemoCalibratedChainsEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env?.CFAGENT_DEMO_CALIBRATED_CHAINS : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim() === "1" || raw.trim().toLowerCase() === "true";
  }
  const demo = (environmentConfig as { demo?: { calibratedChains?: unknown } }).demo;
  return demo?.calibratedChains === true;
}
