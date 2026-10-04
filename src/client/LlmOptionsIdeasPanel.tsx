import { useState } from "react";
import {
  downloadRawOptionsIdeasXls,
  downloadRetrievedOptionsDataXls,
  type RawOptionsIdeasExport,
  type RetrievedOptionsDataExport,
} from "./optionsIdeasExport";
import "./optionsResearch.css";

interface LlmOptionsIdeasResponse {
  mode: "raw_etrade_options_ideas";
  llmInput?: RawOptionsIdeasExport;
  retrievedData?: RetrievedOptionsDataExport;
  dataCoverage: {
    expirationCount: number;
    chainCount: number;
    contractCount: number;
    sentContractCount?: number;
    estimatedInputTokens?: number;
    inputTruncated?: boolean;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    answer?: string;
    contractSymbols?: string[];
  };
}

interface LlmOptionsIdeasPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

export function LlmOptionsIdeasPanel({ activeEnv, userLogin }: LlmOptionsIdeasPanelProps) {
  const [symbol, setSymbol] = useState("");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<LlmOptionsIdeasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    setExportError("");
    try {
      const response = await fetch("/api/trading/options/llm-ideas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify({ symbol: symbol.trim().toUpperCase(), question: question.trim() }),
      });
      const data = await response.json() as LlmOptionsIdeasResponse | { error?: string };
      if (!response.ok) {
        if ("retrievedData" in data && data.retrievedData) {
          setResult(data as LlmOptionsIdeasResponse);
          return;
        }
        throw new Error("error" in data ? data.error || "LLM options research request failed." : "LLM options research request failed.");
      }
      setResult(data as LlmOptionsIdeasResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LLM options research request failed.");
    } finally {
      setLoading(false);
    }
  };

  const downloadInput = async () => {
    if (!result?.llmInput) return;
    setExportError("");
    try {
      await downloadRawOptionsIdeasXls(result.llmInput);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the .xls input export.");
    }
  };

  const downloadRetrievedData = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadRetrievedOptionsDataXls(result.retrievedData);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the raw E*TRADE data export.");
    }
  };

  return (
    <section className="trading-section options-research-section llm-options-ideas-panel">
      <header className="options-research-heading">
        <div>
          <p className="options-eyebrow">INDEPENDENT RAW-DATA LLM EXPERIMENT</p>
          <h2>LLM Options Idea Experiment</h2>
          <p>Ask any question about a stock’s option chain in plain English. The LLM receives raw E*TRADE option data without quant candidates or quant analytics; oversized chains are reduced to fit the model context, while all retrieved chains remain downloadable.</p>
        </div>
      </header>

      <form className="options-request-form llm-options-ideas-form" onSubmit={(event) => void submit(event)}>
        <label className="options-field">
          <span>Underlying ticker</span>
          <input
            required
            maxLength={10}
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="e.g. NVDA"
          />
        </label>
        <label className="options-field llm-options-question">
          <span>Your question</span>
          <textarea
            required
            maxLength={4000}
            rows={4}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="For example: Find the strongest options strategies for bullish, bearish, neutral, and directional scenarios. Explain the structure, relevant contract data, and risks."
          />
        </label>
        <button type="submit" disabled={loading || !symbol.trim() || !question.trim()}>
          {loading ? "Fetching complete chains and analyzing…" : "Ask LLM"}
        </button>
      </form>

      <p className="options-assumptions">
        The ticker selects which complete E*TRADE option chains to retrieve; the question can ask for any analysis supported by those data. Exact prompts and the full raw JSON sent to the LLM are available as an Excel 97–2003 .xls export after the request completes.
      </p>
      {error && <div className="options-error" role="alert">{error}</div>}

      {result && (
        <section className="options-comparison" aria-label="Raw-data LLM answer">
          <header className="options-results-header">
            <h3>LLM response</h3>
            <span>
              {result.llm.model || "Configured model"} ·{" "}
              {result.dataCoverage.sentContractCount ?? result.dataCoverage.contractCount} of {result.dataCoverage.contractCount} contracts sent ·{" "}
              {result.dataCoverage.expirationCount} expirations
            </span>
          </header>
          {result.llm.status === "error" && (
            <div className="options-error" role="alert">Analysis/request error: {result.llm.error}</div>
          )}
          {result.llm.status === "complete" && (
            <>
              <article className="options-llm-answer">
                <p>{result.llm.answer}</p>
                {(result.llm.contractSymbols || []).length > 0 && (
                  <p><b>Referenced E*TRADE contracts:</b> {result.llm.contractSymbols?.join(", ")}</p>
                )}
              </article>
            </>
          )}
          {result.llmInput && (
            <button type="button" onClick={() => void downloadInput()}>
              Download exact LLM input (.xls)
            </button>
          )}
          {result.retrievedData && (
            <button type="button" onClick={() => void downloadRetrievedData()}>
              Download all retrieved raw data (.xls)
            </button>
          )}
          {exportError && <div className="options-error" role="alert">Export failed: {exportError}</div>}
          {result.dataCoverage.inputTruncated && (
            <p className="options-comparison-note">
              The LLM input was reduced to fit its context window, prioritizing near-the-money and more liquid strikes across expirations. The raw-data export includes all retrieved chains.
              {result.dataCoverage.estimatedInputTokens
                ? ` Estimated input: ${result.dataCoverage.estimatedInputTokens.toLocaleString()} tokens.`
                : ""}
            </p>
          )}
          <p className="options-comparison-note">
            Retrieved {result.dataCoverage.chainCount} option-chain responses. Contract references are checked against the data sent to the LLM; its response is not an independently verified optimality or execution assessment.
          </p>
        </section>
      )}
    </section>
  );
}
