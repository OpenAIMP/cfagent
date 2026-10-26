/**
 * PR #5 — Model router + verifier.
 *
 * Split from the judge.ts pattern: router.ts handles intent routing
 * (which model for which task), verifier.ts checks evidence.
 *
 * runWithRouting(task, fn) tries cheap → primary → fallback on
 * retryable errors (4006, 3043, 429/quota).
 */

export type TaskKind = "plan" | "execute" | "judge" | "summarize";

export interface ModelChain {
  cheap: string;
  primary: string;
  fallback: string;
}

export const MODEL_CHAINS: Record<TaskKind, ModelChain> = {
  plan: {
    cheap: "@cf/meta/llama-3.1-8b-instruct",
    primary: "@cf/meta/llama-3.1-70b-instruct",
    fallback: "@cf/mistral/mistral-7b-instruct-v0.3",
  },
  execute: {
    cheap: "@cf/meta/llama-3.1-70b-instruct",
    primary: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    fallback: "@cf/meta/llama-3.1-70b-instruct",
  },
  judge: {
    cheap: "@cf/meta/llama-3.1-8b-instruct",
    primary: "@cf/meta/llama-3.1-70b-instruct",
    fallback: "@cf/mistral/mistral-7b-instruct-v0.3",
  },
  summarize: {
    cheap: "@cf/meta/llama-3.1-8b-instruct",
    primary: "@cf/meta/llama-3.1-8b-instruct",
    fallback: "@cf/mistral/mistral-7b-instruct-v0.3",
  },
};

const RETRYABLE_CODES = new Set([4006, 3043, 429]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as any).code ?? (err as any).status;
    if (typeof code === "number" && RETRYABLE_CODES.has(code)) return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("quota") || msg.includes("rate limit") || msg.includes("overloaded")) {
      return true;
    }
  }
  return false;
}

/**
 * Run fn with model fallback. Starts at the chain's cheap tier,
 * advances on retryable errors. Non-retryable errors throw immediately.
 */
/**
 * #1741: the ordered failover list for a task chain (cheap ->
 * primary -> fallback). The gateway port consumes this list so
 * the chain order stays defined here, once, not per call site.
 */
export function chainModels(task: TaskKind): string[] {
  const chain = MODEL_CHAINS[task];
  return [chain.cheap, chain.primary, chain.fallback];
}

export async function runWithRouting<T>(
  task: TaskKind,
  fn: (model: string) => Promise<T>
): Promise<{ result: T; model: string; attempt: number }> {
  const chain = MODEL_CHAINS[task];
  const models = [chain.cheap, chain.primary, chain.fallback];
  let lastError: unknown;

  for (let attempt = 0; attempt < models.length; attempt++) {
    try {
      const result = await fn(models[attempt]);
      return { result, model: models[attempt], attempt };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === models.length - 1) throw err;
    }
  }
  throw lastError;
}
