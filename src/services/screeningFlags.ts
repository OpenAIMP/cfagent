/**
 * Screening-system feature flags (issue #1162, Phase 6 of epic #1096).
 *
 * The repo's flag idiom is `mas_settings` string keys read at the point
 * of use — the same store and fail-safe discipline as the adaptation
 * kill switch (#756, adaptationAudit.ts): safety-relevant reads fail
 * CLOSED. Concretely:
 *
 *  - Enable flags (`screening.channelsEnabled`,
 *    `screening.weightsV2Ranking`): default OFF; a read failure reads
 *    as OFF. Learned weighting stays behind this explicit switch per
 *    the #17 reviewed-config posture recorded on the
 *    /adaptation/weights route ("production consumption stays behind
 *    #17's reviewed-config rule").
 *  - Pause flag (`screening.scheduledPaused`): default not paused; a
 *    read failure reads as PAUSED — an autonomous schedule whose pause
 *    state cannot be verified does not run (kill-switch idiom).
 *  - NLQ fit discovery (`screening.nlqFitDiscovery`): an OFF-switch
 *    for an additive parser feature; default ON, only an explicit
 *    "off" disables it.
 *  - Rollout stage (`screening.rolloutStage`): internal → paper →
 *    broader. Recorded, never auto-advanced — a stage changes only
 *    through an explicit settings write (the /screening/controls
 *    route), which the activity log records with its actor.
 *
 * Readers take a `ScreeningSettingRead` function so both sql-backed
 * stores (DO SqlStorage / DatabaseORM exec) and route contexts
 * (OrchestratorAgent.readSettingRaw) drive the same code.
 */

export const SCREENING_FLAG_KEYS = {
  rolloutStage: "screening.rolloutStage",
  channelsEnabled: "screening.channelsEnabled",
  nlqFitDiscovery: "screening.nlqFitDiscovery",
  weightsV2Ranking: "screening.weightsV2Ranking",
  scheduledPaused: "screening.scheduledPaused",
} as const;

export type ScreeningSettingRead = (key: string) => string | null;
export type ScreeningSettingWrite = (key: string, value: string) => void;

export type ScreeningRolloutStage = "internal" | "paper" | "broader";
export const SCREENING_ROLLOUT_STAGES: ScreeningRolloutStage[] = [
  "internal",
  "paper",
  "broader",
];

const TRUTHY = new Set(["on", "1", "true", "yes"]);
const FALSY = new Set(["off", "0", "false", "no"]);

function ensureSettingsTable(sql: { exec: (q: string, ...a: unknown[]) => Iterable<unknown> }): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`
  );
}

/** Build a settings reader over any exec-shaped sql store (DO SqlStorage or DatabaseORM). */
export function settingReadFromSql(sql: {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
}): ScreeningSettingRead {
  return (key: string) => {
    ensureSettingsTable(sql);
    const rows = Array.from(
      sql.exec(`SELECT value FROM mas_settings WHERE key = ?`, key)
    ) as Array<{ value?: unknown }>;
    return rows.length > 0 ? String(rows[0].value ?? "") : null;
  };
}

/** Build a settings writer over any exec-shaped sql store (delete+insert idiom). */
export function settingWriteFromSql(sql: {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
}): ScreeningSettingWrite {
  return (key: string, value: string) => {
    ensureSettingsTable(sql);
    sql.exec(`DELETE FROM mas_settings WHERE key = ?`, key);
    sql.exec(
      `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      key,
      value,
      new Date().toISOString()
    );
  };
}

/** Validated settings write: the rollout stage only accepts known stages. */
export function setScreeningSetting(
  write: ScreeningSettingWrite,
  key: string,
  value: string
): void {
  if (key === SCREENING_FLAG_KEYS.rolloutStage && !isScreeningRolloutStage(value)) {
    throw new Error(
      `Invalid rollout stage "${value}" (expected one of ${SCREENING_ROLLOUT_STAGES.join(", ")}).`
    );
  }
  write(key, value);
}

export function isScreeningRolloutStage(v: unknown): v is ScreeningRolloutStage {
  return typeof v === "string" && (SCREENING_ROLLOUT_STAGES as string[]).includes(v);
}

const READ_FAILED = Symbol("screeningFlags.readFailed");

/**
 * Read one key, distinguishing the three states the fail-safes depend
 * on: a stored value, an absent key (null — the flag's default
 * applies), and a failed read (READ_FAILED — the fail-safe applies).
 */
function readSafe(
  read: ScreeningSettingRead,
  key: string
): string | null | typeof READ_FAILED {
  try {
    return read(key);
  } catch (err) {
    console.error(
      `[screeningFlags] read of ${key} failed; applying the fail-safe value:`,
      err
    );
    return READ_FAILED;
  }
}

/**
 * Boolean flag read. Absent key = false (every boolean screening
 * flag's default is the inactive state). A failed read returns
 * `onError`: OFF for enable flags, ON (paused) for the pause flag.
 * An unrecognized stored value also falls back to `onError` rather
 * than guessing.
 */
function readBool(read: ScreeningSettingRead, key: string, onError: boolean): boolean {
  const raw = readSafe(read, key);
  if (raw === READ_FAILED) return onError;
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return onError;
}

/** Current rollout stage; absent/unknown/unreadable values read as the safest stage, "internal". */
export function getScreeningRolloutStage(read: ScreeningSettingRead): ScreeningRolloutStage {
  const raw = readSafe(read, SCREENING_FLAG_KEYS.rolloutStage);
  return isScreeningRolloutStage(raw) ? raw : "internal";
}

/** Push-channel delivery wiring (Slack/email/webhook) is enabled. Default OFF; read failure = OFF. */
export function isScreeningChannelsEnabled(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.channelsEnabled, false);
}

/**
 * V2 weights may influence fit-discovery ranking. Default OFF (the #17
 * reviewed-config posture); read failure = OFF.
 */
export function isWeightsV2RankingEnabled(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.weightsV2Ranking, false);
}

/**
 * Scheduled autonomous screening steps are paused. Default (absent
 * key) = not paused; read failure = PAUSED (fail-closed, the
 * kill-switch idiom — a pause state that cannot be verified halts).
 */
export function isScreeningScheduledPaused(read: ScreeningSettingRead): boolean {
  return readBool(read, SCREENING_FLAG_KEYS.scheduledPaused, true);
}

/**
 * NLQ fit-discovery phrases are enabled. This is an OFF-switch for an
 * additive, honest-failing parser feature: default ON; only an explicit
 * off value disables it; an unreadable setting leaves it ON (logged).
 */
export function isNlqFitDiscoveryEnabled(read: ScreeningSettingRead): boolean {
  const raw = readSafe(read, SCREENING_FLAG_KEYS.nlqFitDiscovery);
  if (raw === READ_FAILED || raw === null) return true;
  return !FALSY.has(raw.trim().toLowerCase());
}

/** Snapshot of every screening flag, for the controls surface and the runbook checks. */
export function readScreeningControls(read: ScreeningSettingRead): {
  rolloutStage: ScreeningRolloutStage;
  channelsEnabled: boolean;
  nlqFitDiscovery: boolean;
  weightsV2Ranking: boolean;
  scheduledPaused: boolean;
} {
  return {
    rolloutStage: getScreeningRolloutStage(read),
    channelsEnabled: isScreeningChannelsEnabled(read),
    nlqFitDiscovery: isNlqFitDiscoveryEnabled(read),
    weightsV2Ranking: isWeightsV2RankingEnabled(read),
    scheduledPaused: isScreeningScheduledPaused(read),
  };
}
