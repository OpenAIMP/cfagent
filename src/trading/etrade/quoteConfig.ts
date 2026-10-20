/**
 * Issue #812: externalized quote pipeline configuration.
 *
 * All knobs for the E*TRADE quote pipeline live here — no code changes
 * needed to tune batching, retries, logging, or UI visibility.
 */

export interface QuotePipelineConfig {
  /** Symbols per E*TRADE batch request. */
  batchSize: number;
  /** Ms between batches (rate limit safety). */
  batchGapMs: number;
  /** Symbols per retry chunk for missing quotes. */
  retryBatchSize: number;
  /** Ms between retry chunks. */
  retryDelayMs: number;
  /** Max retry attempts per symbol. */
  maxRetries: number;
  logging: {
    /** Log batch start/complete events. */
    logBatches: boolean;
    /** Log per-symbol failures. */
    logSymbolFailures: boolean;
    /** Log the final summary. */
    logSummary: boolean;
    /** Minimum failure category to log (filters noise). */
    minFailureLevel: "all" | "error_only";
  };
  ui: {
    /** Show quote trace section in the report UI. */
    showTrace: boolean;
    /** Show per-batch breakdown. */
    showBatches: boolean;
    /** Show per-symbol failure list. */
    showFailures: boolean;
    /** Max failures to display (rest summarized). */
    maxFailuresShown: number;
  };
}

/** Defaults — override via environment or config file. */
export const DEFAULT_QUOTE_CONFIG: QuotePipelineConfig = {
  batchSize: 10,
  batchGapMs: 100,
  retryBatchSize: 10,
  retryDelayMs: 500,
  maxRetries: 3,
  logging: {
    logBatches: true,
    logSymbolFailures: true,
    logSummary: true,
    minFailureLevel: "all",
  },
  ui: {
    showTrace: true,
    showBatches: true,
    showFailures: true,
    maxFailuresShown: 20,
  },
};

/**
 * Load config with environment overrides.
 * Env vars: QUOTE_BATCH_SIZE, QUOTE_BATCH_GAP_MS, QUOTE_LOG_BATCHES (true/false), etc.
 */
export function loadQuoteConfig(env?: Record<string, string | undefined>): QuotePipelineConfig {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_QUOTE_CONFIG)) as QuotePipelineConfig;
  if (!env) return cfg;

  const int = (key: string, fallback: number): number => {
    const v = env[key];
    if (!v) return fallback;
    const n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = env[key]?.toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    return fallback;
  };

  cfg.batchSize = int("QUOTE_BATCH_SIZE", cfg.batchSize);
  cfg.batchGapMs = int("QUOTE_BATCH_GAP_MS", cfg.batchGapMs);
  cfg.retryBatchSize = int("QUOTE_RETRY_BATCH_SIZE", cfg.retryBatchSize);
  cfg.retryDelayMs = int("QUOTE_RETRY_DELAY_MS", cfg.retryDelayMs);
  cfg.maxRetries = int("QUOTE_MAX_RETRIES", cfg.maxRetries);
  cfg.logging.logBatches = bool("QUOTE_LOG_BATCHES", cfg.logging.logBatches);
  cfg.logging.logSymbolFailures = bool("QUOTE_LOG_SYMBOL_FAILURES", cfg.logging.logSymbolFailures);
  cfg.logging.logSummary = bool("QUOTE_LOG_SUMMARY", cfg.logging.logSummary);
  cfg.ui.showTrace = bool("QUOTE_UI_SHOW_TRACE", cfg.ui.showTrace);
  cfg.ui.showBatches = bool("QUOTE_UI_SHOW_BATCHES", cfg.ui.showBatches);
  cfg.ui.showFailures = bool("QUOTE_UI_SHOW_FAILURES", cfg.ui.showFailures);
  cfg.ui.maxFailuresShown = int("QUOTE_UI_MAX_FAILURES", cfg.ui.maxFailuresShown);

  return cfg;
}
