import type { NewsFlowItem } from "../../../trading";

/**
 * Issue #132: how a news item's sentiment is presented in the flows hub.
 *
 * Sentiment is an LLM model assessment of the headline, not a measured
 * market signal — the presentation must say so. Items whose sentimentMethod
 * is "llm" render their label with an "· AI" marker and a tooltip naming
 * the model. Items with method "unavailable" have NO assessment: they
 * render "Not assessed" and must never show the neutral default as if the
 * model judged the headline neutral.
 */
export interface NewsSentimentPresentation {
  assessed: boolean;
  label: string;
  title: string;
  className: string;
}

const SENTIMENT_LABELS: Record<NewsFlowItem["sentiment"], string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

export function newsSentimentPresentation(
  item: Pick<NewsFlowItem, "sentiment" | "sentimentMethod" | "sentimentModel">,
): NewsSentimentPresentation {
  if (item.sentimentMethod === "llm") {
    const model = item.sentimentModel || "Neural Language Model";
    return {
      assessed: true,
      label: `${SENTIMENT_LABELS[item.sentiment]} · AI`,
      title: `Sentiment assessed by ${model} (LLM) from the headline text. This is a model assessment, not a measured market signal.`,
      className: `news-sentiment-badge ${item.sentiment}`,
    };
  }
  return {
    assessed: false,
    label: "Not assessed",
    title:
      "No sentiment assessment for this headline — the LLM sentiment pass did not run or did not label it " +
      "(disabled, no AI binding, quota exhausted, or unparseable model output). The headline itself is real; only the assessment is missing.",
    className: "news-sentiment-badge unassessed",
  };
}
