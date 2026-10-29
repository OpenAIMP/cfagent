/**
 * src/data/settingsReadPorts.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A): the mas_settings READ port. DO residency (the
 * table lives in the orchestrator's instance storage).
 *
 * READ-ONLY BY DESIGN (gate G-7): mas_settings has six raw
 * writers and no single owner; ownership is ruled in step 4,
 * so this slice lands the read contract only — no write
 * method exists on this port and no writer is rewired. Reads
 * that used to hand a raw SqlStorage to helpers (e.g.
 * adaptationAudit's halt check) can take this port instead
 * when their owning slice wires it.
 *
 * #CDO-mha7
 */

/** Read-only view over mas_settings (key → value). */
export interface SettingsReadPort {
  /** The stored value for key, or null when absent. */
  get(key: string): string | null;
  /** Whether a value is stored for key. */
  has(key: string): boolean;
}
