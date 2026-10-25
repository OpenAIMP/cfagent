/**
 * #583 — versioned evaluation datasets for research outcome evaluation.
 *
 * Datasets live under `evaluations/datasets/<version>/` as JSON (bundled via
 * resolveJsonModule, so this works in the Worker and in vitest). Each version
 * has a manifest (provenance, dimensions) and a cases file. Datasets are
 * held-out fixtures: synthetic, never production runs.
 */
import manifestV1 from "../../evaluations/datasets/v1/manifest.json";
import casesV1 from "../../evaluations/datasets/v1/cases.json";
import manifestV2 from "../../evaluations/datasets/v2/manifest.json";
import casesV2 from "../../evaluations/datasets/v2/cases.json";
import type { StoredIdeaRecord } from "./researchPipeline";

export interface EvaluationDatasetManifest {
  version: string;
  created: string;
  provenance: string;
  casesFile: string;
  dimensions: string[];
  notes?: string;
}

export interface EvaluationDatasetCase {
  caseId: string;
  description: string;
  runId: string;
  rulesVersion: string;
  /** Follow-up spot prices by symbol; absent symbol = unavailable quote. */
  followUp: Record<string, number>;
  ideas: StoredIdeaRecord[];
  expect?: Record<string, unknown>;
}

export interface EvaluationDataset {
  manifest: EvaluationDatasetManifest;
  cases: EvaluationDatasetCase[];
}

const REGISTRY: Record<string, { manifest: unknown; cases: unknown }> = {
  v1: { manifest: manifestV1, cases: casesV1 },
  // v2 (#1140, epic #1096 Phase 5): frozen champion/challenger sets
  // across regimes and strategy families, ordered for walk-forward
  // folds (selection first, holdout last).
  v2: { manifest: manifestV2, cases: casesV2 },
};

function isManifest(m: unknown): m is EvaluationDatasetManifest {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.version === "string" &&
    typeof o.provenance === "string" &&
    Array.isArray(o.dimensions)
  );
}

function isCase(c: unknown): c is EvaluationDatasetCase {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.caseId === "string" &&
    typeof o.runId === "string" &&
    Array.isArray(o.ideas) &&
    (o.followUp === undefined || typeof o.followUp === "object")
  );
}

/**
 * Load and validate an evaluation dataset version. Throws on unknown
 * version or malformed content — a corrupt dataset must fail loudly,
 * never silently evaluate against wrong fixtures.
 */
export function loadEvaluationDataset(version: string): EvaluationDataset {
  const entry = REGISTRY[version];
  if (!entry) {
    throw new Error(
      `Unknown research evaluation dataset version: ${version} ` +
        `(available: ${Object.keys(REGISTRY).join(", ")})`
    );
  }
  if (!isManifest(entry.manifest)) {
    throw new Error(`Dataset ${version}: manifest is malformed`);
  }
  if (!Array.isArray(entry.cases) || !entry.cases.every(isCase)) {
    throw new Error(`Dataset ${version}: cases are malformed`);
  }
  const cases = (entry.cases as EvaluationDatasetCase[]).map((c) => ({
    ...c,
    followUp: c.followUp ?? {},
  }));
  return { manifest: entry.manifest, cases };
}

/** Fetch one case by ID; throws when absent. */
export function getDatasetCase(
  ds: EvaluationDataset,
  caseId: string
): EvaluationDatasetCase {
  const c = ds.cases.find((x) => x.caseId === caseId);
  if (!c) {
    throw new Error(
      `Dataset ${ds.manifest.version}: unknown case ${caseId} ` +
        `(available: ${ds.cases.map((x) => x.caseId).join(", ")})`
    );
  }
  return c;
}
