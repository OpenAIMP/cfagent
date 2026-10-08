import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";
import { getAiConfig, getAvailableAiModels, type AiModelDefinition, type AiConfig } from "../config/etapiConfig";

export { getAiConfig, getAvailableAiModels, type AiModelDefinition, type AiConfig };

/**
 * Flagship active Cloudflare Workers AI model with 131k context,
 * native tool/function calling, high-speed streaming, and reasoning support.
 *
 * Replaces deprecated @cf/meta/llama-3.1-8b-instruct (deprecated 2026-05-30).
 */
export const DEFAULT_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export const FALLBACK_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Resolves the appropriate model ID dynamically based on task key, explicit override,
 * environment config, or global default.
 */
export function resolveAiModelName(env?: Partial<Env>, taskOrCustomModel?: string): string {
  try {
    const aiConfig = getAiConfig(env);
    if (taskOrCustomModel) {
      if (aiConfig.taskModels && taskOrCustomModel in aiConfig.taskModels) {
        const taskModel = aiConfig.taskModels[taskOrCustomModel];
        if (taskModel) return taskModel;
      }
      return taskOrCustomModel;
    }
    return env?.AI_MODEL || aiConfig.defaultModel || DEFAULT_AI_MODEL;
  } catch {
    return taskOrCustomModel || env?.AI_MODEL || DEFAULT_AI_MODEL;
  }
}

export function getWorkersAIModel(env: Env, taskOrCustomModel?: string) {
  const modelName = resolveAiModelName(env, taskOrCustomModel);
  return createWorkersAI({ binding: env.AI })(modelName);
}

