import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";

/**
 * Flagship active Cloudflare Workers AI model with 131k context,
 * native tool/function calling, high-speed streaming, and reasoning support.
 *
 * Replaces deprecated @cf/meta/llama-3.1-8b-instruct (deprecated 2026-05-30).
 */
export const DEFAULT_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export const FALLBACK_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function getWorkersAIModel(env: Env, customModel?: string) {
  const modelName = customModel || env.AI_MODEL || DEFAULT_AI_MODEL;
  return createWorkersAI({ binding: env.AI })(modelName);
}
