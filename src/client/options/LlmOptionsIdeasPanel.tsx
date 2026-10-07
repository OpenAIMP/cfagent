import { useState } from "react";
import { apiFetch as fetch } from "../apiFetch";
import {
  downloadRawOptionsIdeasXls,
  downloadOptionsIdeasReportXls,
  downloadRetrievedOptionsDataXls,
  type OptionsIdeasReportExport,
  type RawOptionsIdeasExport,
  type RetrievedOptionsDataExport,
} from "./optionsIdeasExport";
import "./optionsResearch.css";

export interface LlmOptionsIdeasResponse {
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
    cached?: boolean;
    fetchedAt?: number;
  };
  groups?: OptionsIdeasReportExport["groups"];
  finalAnalysis?: OptionsIdeasReportExport["finalAnalysis"] & {
    systemPrompt?: string;
    userPrompt?: string;
  };
  llm: {
    status: "complete" | "error";
    model?: string;
    error?: string;
    answer?: string;
    contractSymbols?: string[];
  };
}

export interface LlmOptionsIdeasPanelProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

export function LlmOptionsIdeasPanel({ activeEnv, userLogin }: LlmOptionsIdeasPanelProps) {
  const [symbol, setSymbol] = useState("NVDA");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<LlmOptionsIdeasResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");

  const runAnalysis = async (requestedQuestion: string, forceRefresh = false) => {
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
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          question: requestedQuestion.trim(),
          refresh: forceRefresh,
        }),
      });
      const data = (await response.json()) as LlmOptionsIdeasResponse | { error?: string };
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

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAnalysis(question);
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

  const downloadReport = async () => {
    if (!result?.retrievedData) return;
    setExportError("");
    try {
      await downloadOptionsIdeasReportXls({
        symbol: result.retrievedData.symbol,
        question: result.retrievedData.question,
        dataCoverage: result.dataCoverage,
        groups: result.groups || [],
        finalAnalysis: result.finalAnalysis || { status: result.llm.status, model: result.llm.model, answer: result.llm.answer, error: result.llm.error },
      });
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not create the .xls analysis report.");
    }
  };

  const sampleQuestions = [
    "Find the strongest bullish, bearish, and neutral options strategy in each expiration group. Explain exact legs and risks.",
    "For each expiration group, identify the best defined-risk bullish strategy using the available calls and puts.",
    "Compare near-, mid-, and long-term chains for the best strategy when I expect the underlying to move sharply in either direction.",
    "Find the best neutral or income-oriented strategy in each expiration group and explain the market conditions it needs.",
  ];

  return (
    <section className="trading-section options-research-section llm-options-ideas-panel">
      <header className="options-research-heading">
        <div>
          <p className="options-eyebrow">INDEPENDENT RAW-DATA LLM EXPERIMENT</p>
          <h2>LLM Options Idea Experiment</h2>
          <p>The experiment divides retrieved chains into near-term (0–30 DTE), mid-term (31–90 DTE), and long-term (91+ DTE) groups. Each group is analyzed independently from raw E*TRADE data; a final LLM request ranks the group winners for your question. Options chains are persistently stored in SQLite and updated upon refresh.</p>
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
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
          <button type="submit" disabled={loading || !symbol.trim() || !question.trim()}>
            {loading ? "Analyzing chains with Workers AI…" : "Ask LLM"}
          </button>
          <button
            type="button"
            className="options-eval-llm-btn"
            disabled={loading || !symbol.trim() || !question.trim()}
            onClick={() => void runAnalysis(question, true)}
            title="Force refresh live E*TRADE chains and update persistent SQLite cache"
            style={{ minHeight: "38px" }}
          >
            🔄 Refresh Chains
          </button>
        </div>
      </form>

      <div className="llm-ideas-samples" aria-label="Sample analysis questions">
        <strong>Try a sample:</strong>
        {sampleQuestions.map((sample) => (
          <button
            key={sample}
            type="button"
            disabled={loading || !symbol.trim()}
            onClick={() => {
              setQuestion(sample);
              void runAnalysis(sample);
            }}
          >
            {sample}
          </button>
        ))}
      </div>

      <p className="options-assumptions">
        Sample questions submit immediately using the ticker above. All group requests and the final ranking input are available as an Excel 97–2003 .xls export. The analysis report, exact LLM inputs, and all retrieved raw chains can each be downloaded after retrieval.
      </p>
      {error && <div className="options-error" role="alert">{error}</div>}

      {result && (
        <section className="options-comparison" aria-label="Raw-data LLM analysis">
          <header className="options-results-header">
            <div>
              <h3>LLM analysis report</h3>
              <span>
                {result.llm.model || "Configured model"} ·{" "}
                {result.dataCoverage.sentContractCount ?? result.dataCoverage.contractCount} of {result.dataCoverage.contractCount} contracts sent ·{" "}
                {result.dataCoverage.expirationCount} expirations
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              {result.dataCoverage.cached && (
                <span
                  style={{
                    padding: "0.2rem 0.55rem",
                    borderRadius: "999px",
                    background: "rgba(16, 185, 129, 0.15)",
                    border: "1px solid rgba(16, 185, 129, 0.35)",
                    color: "#6ee7b7",
                    fontSize: "0.72rem",
                    fontWeight: 700,
                  }}
                  title="Accelerated from SQLite options chain cache"
                >
                  ⚡ Stored SQLite Cache
                </span>
              )}
            </div>
          </header>
          {result.finalAnalysis?.status === "complete" ? (
            <article className="options-llm-answer">
              <h4>Overall group-winner ranking</h4>
              <p>{result.finalAnalysis.answer}</p>
              {(result.finalAnalysis.rankings || []).map((item) => {
                const group = result.groups?.find((entry) => entry.id === item.groupId);
                return (
                  <div className="llm-ideas-ranking" key={item.groupId}>
                    <strong>#{item.rank} · {group?.label || item.groupId}</strong>
                    <span>{item.strategy}</span>
                    <p>{item.rationale}</p>
                  </div>
                );
              })}
            </article>
          ) : (
            <div className="options-error" role="alert">
              Final cross-group ranking is unavailable: {result.finalAnalysis?.error || result.llm.error || "No completed group analyses were available."} Group-level results below are still available; no overall winner is inferred.
            </div>
          )}
          {(result.groups || []).map((group) => (
            <article className="options-llm-answer llm-ideas-group" key={group.id}>
              <header>
                <h4>{group.label}</h4>
                <span>{group.status === "complete" ? `${group.contractCount} contracts · ${group.expirationCount} expirations` : "Analysis failed"}</span>
              </header>
              {group.status === "complete"
                ? <p>{group.answer}</p>
                : <div className="options-error" role="alert">{group.error}</div>}
              {(group.contractSymbols || []).length > 0 && (
                <p><b>Referenced E*TRADE contracts:</b> {group.contractSymbols?.join(", ")}</p>
              )}
              {(group.contractDetails || []).length > 0 && (
                <div className="options-table-scroll">
                  <table className="options-table">
                    <thead>
                      <tr>
                        <th>Expiry</th>
                        <th>Contract</th>
                        <th>Type</th>
                        <th>Strike</th>
                        <th>Bid</th>
                        <th>Ask</th>
                        <th>Last</th>
                        <th>Volume</th>
                        <th>Open interest</th>
                        <th>Delta</th>
                        <th>IV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.contractDetails?.map(({ symbol: contractSymbol, expiration, contract }) => (
                        <tr key={contractSymbol}>
                          <td>{expiration}</td>
                          <td>{contractSymbol}</td>
                          <td>{contract.optionType}</td>
                          <td>{contract.strikePrice}</td>
                          <td>{contract.bid}</td>
                          <td>{contract.ask}</td>
                          <td>{contract.lastPrice}</td>
                          <td>{contract.volume ?? "—"}</td>
                          <td>{contract.openInterest ?? "—"}</td>
                          <td>{contract.delta ?? "—"}</td>
                          <td>{contract.impliedVolatility ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(group.contractWarnings || []).map((warning) => (
                <p className="options-comparison-note" role="note" key={warning}>{warning}</p>
              ))}
              {group.inputTruncated && (
                <p className="options-comparison-note">Input was sampled to fit the model context ({group.sentContractCount} of {group.contractCount} group contracts sent).</p>
              )}
            </article>
          ))}
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            <button type="button" className="options-eval-llm-btn" onClick={() => void downloadReport()}>
              📥 Download analysis report (.xls)
            </button>
            {result.llmInput && (
              <button type="button" className="options-eval-llm-btn" onClick={() => void downloadInput()}>
                📥 Download exact inputs (.xls)
              </button>
            )}
            {result.retrievedData && (
              <button type="button" className="options-eval-llm-btn" onClick={() => void downloadRetrievedData()}>
                📥 Download all retrieved raw data (.xls)
              </button>
            )}
          </div>
          {exportError && <div className="options-error" role="alert">Export failed: {exportError}</div>}
          {result.dataCoverage.inputTruncated && (
            <p className="options-comparison-note">
              One or more group inputs were reduced to fit the context window, prioritizing near-the-money and more liquid strikes across expirations. The raw-data export includes all retrieved chains.
              {result.dataCoverage.estimatedInputTokens
                ? ` Estimated input: ${result.dataCoverage.estimatedInputTokens.toLocaleString()} tokens.`
                : ""}
            </p>
          )}
          <p className="options-comparison-note">
            Retrieved {result.dataCoverage.chainCount} option-chain responses. Contract references are checked against the data sent to each LLM request; these recommendations are not independently verified optimality or execution assessments.
          </p>
        </section>
      )}
    </section>
  );
}
