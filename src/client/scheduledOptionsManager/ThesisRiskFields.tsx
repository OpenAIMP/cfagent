import React from "react";
import { Select } from "../components/ui";
import type { CreatableJob } from "./types";

export interface ThesisRiskFieldsProps {
  jobType: CreatableJob;
  thesis: "bullish" | "bearish" | "neutral" | "directional";
  setThesis: React.Dispatch<React.SetStateAction<"bullish" | "bearish" | "neutral" | "directional">>;
  riskProfile: "conservative" | "balanced" | "aggressive";
  setRiskProfile: React.Dispatch<React.SetStateAction<"conservative" | "balanced" | "aggressive">>;
}

export function ThesisRiskFields(props: ThesisRiskFieldsProps) {
  const { jobType, thesis, setThesis, riskProfile, setRiskProfile } = props;
  if (jobType !== "optionsAnalysis") return null;
  return (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
                  <div className="sched-form-group">
                    <label htmlFor="sched-market-thesis" className="sched-form-label">Market Thesis / Outlook</label>
                    <Select id="sched-market-thesis"
                      value={thesis}
                      onChange={(e) => setThesis(e.target.value as any)}
                    >
                      <option value="bullish">Bullish (Calls, Bull Spreads)</option>
                      <option value="bearish">Bearish (Puts, Bear Spreads)</option>
                      <option value="neutral">Neutral (Iron Condor, Calendar)</option>
                      <option value="directional">Directional (Breakouts &amp; Straddles)</option>
                    </Select>
                  </div>

                  <div className="sched-form-group">
                    <label htmlFor="sched-risk-profile" className="sched-form-label">Risk Profile</label>
                    <Select id="sched-risk-profile"
                      value={riskProfile}
                      onChange={(e) => setRiskProfile(e.target.value as any)}
                    >
                      <option value="conservative">Conservative (High POP &gt; 65%, Defined Risk)</option>
                      <option value="balanced">Balanced (Optimal R/R &gt; 1.5x, Moderate POP)</option>
                      <option value="aggressive">Aggressive (Maximum Leverage &amp; Upside)</option>
                    </Select>
                  </div>
                </div>
  );
}
