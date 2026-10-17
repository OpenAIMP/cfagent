/**
 * Gate for LLM news-sentiment classification — issue #132.
 *
 * When enabled, fetchRealMarketNews runs ONE batched Workers AI
 * classification over each fresh cache fill and stamps items with
 * sentimentMethod "llm". When disabled (or the model call fails), items
 * ship with sentimentMethod "unavailable" and no model call is made.
 *
 * Configure via either:
 *   - environment.config.json:  "news": { "sentiment": false }
 *   - environment variable:     CFAGENT_NEWS_SENTIMENT=0 (or "false")
 * Default: enabled — the gate exists as an off switch (e.g. while the
 * Workers AI neuron quota is exhausted), not as an opt-in.
 */

import environmentConfig from "../../environment.config.json";

export function isNewsSentimentEnabled(): boolean {
  const raw = typeof process !== "undefined" ? process.env?.CFAGENT_NEWS_SENTIMENT : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const v = raw.trim().toLowerCase();
    if (v === "0" || v === "false") return false;
    if (v === "1" || v === "true") return true;
  }
  const news = (environmentConfig as { news?: { sentiment?: unknown } }).news;
  if (typeof news?.sentiment === "boolean") return news.sentiment;
  return true;
}
