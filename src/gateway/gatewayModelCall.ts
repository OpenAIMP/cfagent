/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Shared AI SDK call for both gateway executors (the only
 * difference between them is how the model object is built).
 * AI SDK 7 notes: generateObject results carry no `text` field,
 * so the schema path returns JSON.stringify(object) as text;
 * prompt/messages are branched (never undefined-valued) because
 * the Prompt union requires exactly one defined member.
 */
import { generateObject, generateText, stepCountIs } from "ai";
import type { ModelExecutorInput } from "./gatewayPorts";

export async function executeModelCall(
  model: unknown,
  input: ModelExecutorInput,
): Promise<{ text: string; object?: unknown }> {
  const shared = {
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  };
  if (input.schema !== undefined) {
    const result =
      input.messages !== undefined
        ? await generateObject({
            model: model as never,
            schema: input.schema,
            ...shared,
            messages: input.messages as never,
          })
        : await generateObject({
            model: model as never,
            schema: input.schema,
            ...shared,
            prompt: input.prompt as string,
          });
    return { text: JSON.stringify(result.object), object: result.object };
  }
  const tools = input.tools !== undefined ? { tools: input.tools } : {};
  const stop = input.maxSteps !== undefined ? { stopWhen: stepCountIs(input.maxSteps) } : {};
  const result =
    input.messages !== undefined
      ? await generateText({ model: model as never, messages: input.messages as never, ...shared, ...tools, ...stop })
      : await generateText({ model: model as never, prompt: input.prompt as string, ...shared, ...tools, ...stop });
  return { text: result.text };
}
